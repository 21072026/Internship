// Admin tier & scope assignment (#1579) — the one writer of `User.adminLevel`
// and of `AdminScopeGrant` rows from the admin screen. Server-only.
//
// WHO may call this is decided before it is called, by
// requirePermission('admin.grant') — the ONE permission rule
// (src/lib/authzRule.ts). What this file adds is what a permission cannot see:
// the guards of src/lib/adminTierRule.ts (no self-change, never above one's
// own tier, the last active ORG_ADMIN stays, grants only for PROGRAM_ADMIN).
//
// A TIER CHANGE SIGNS THE PERSON OUT. The tier rides in the JWT
// (token.adminLevel), so the change stamps `sessionsValidFrom` AND revokes
// every trusted device — CLAUDE.md: a cutoff without revokeAllTrustedDevices()
// lets a remembered browser sign straight back in, and here it would come back
// with the old tier in its token. Grants are different: requirePermission()
// reads them LIVE on every request, so adding or removing one changes the next
// request without a sign-out.
//
// Every change writes an AuditLog row (ADMIN_LEVEL_CHANGE / ADMIN_SCOPE_GRANT /
// ADMIN_SCOPE_REVOKE) with orgId, so the audit stream (#2012) carries it.

import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { revokeAllTrustedDevices } from '@/lib/trustedDevice';
import { orgWhere } from '@/lib/tenantFilter';
import { defaultOrgId } from '@/lib/defaultOrg';
import { adminTierFor, type AdminTier } from '@/lib/authzRule';
import { grantRefusal, tierChangeRefusal, type GrantRefusal, type TierRefusal } from '@/lib/adminTierRule';

/** ACTIVE ORG_ADMINs of an org other than `excludeUserId` (an empty column on an ADMIN is ORG_ADMIN). */
export async function countOtherActiveOrgAdmins(orgId: string | null, excludeUserId: string): Promise<number> {
  return prisma.user.count({
    where: {
      AND: [
        { role: 'ADMIN', isActive: true, id: { not: excludeUserId }, OR: [{ adminLevel: null }, { adminLevel: 'ORG_ADMIN' }] },
        await orgWhere(orgId ?? (await defaultOrgId())),
      ],
    },
  });
}

/** Would losing this account (deactivation, deletion) take the org's last active ORG_ADMIN? */
export async function isLastActiveOrgAdmin(user: { id: string; role: string; adminLevel: string | null; orgId: string | null }): Promise<boolean> {
  if (adminTierFor(user.role, user.adminLevel) !== 'ORG_ADMIN') return false;
  return (await countOtherActiveOrgAdmins(user.orgId, user.id)) < 1;
}

interface ActorRef {
  id: string;
  email?: string | null;
  orgId: string | null;
  tier: AdminTier | null;
}

type Outcome = { ok: true; changed: boolean } | { ok: false; status: 400 | 404 | 409; code: TierRefusal | GrantRefusal | 'not_found' | 'outside_org' | 'duplicate_grant' };

async function targetInOrg(actor: ActorRef, targetId: string) {
  return prisma.user.findFirst({
    where: { AND: [{ id: targetId }, await orgWhere(actor.orgId ?? (await defaultOrgId()))] },
    select: { id: true, role: true, adminLevel: true, orgId: true },
  });
}

async function audit(actor: ActorRef, action: string, targetId: string, detail: string) {
  await prisma.auditLog.create({ data: { orgId: actor.orgId, actorId: actor.id, action, targetId, detail } });
}

export async function changeAdminTier(actor: ActorRef, targetId: string, next: AdminTier, request?: Request): Promise<Outcome> {
  const target = await targetInOrg(actor, targetId);
  if (!target) return { ok: false, status: 404, code: 'not_found' };
  const current = adminTierFor(target.role, target.adminLevel);
  const refusal = tierChangeRefusal({
    actorId: actor.id,
    actorTier: actor.tier,
    targetId: target.id,
    targetRole: target.role,
    targetLevel: target.adminLevel,
    next,
    otherActiveOrgAdmins: current === 'ORG_ADMIN' && next !== 'ORG_ADMIN' ? await countOtherActiveOrgAdmins(target.orgId, target.id) : 1,
  });
  if (refusal) return { ok: false, status: refusal === 'last_org_admin' ? 409 : 400, code: refusal };
  // Idempotent: the tier asked for is the tier in effect (an empty column on
  // an ADMIN already IS ORG_ADMIN) — no write, no sign-out.
  if (current === next) return { ok: true, changed: false };

  await prisma.user.update({ where: { id: target.id }, data: { adminLevel: next, sessionsValidFrom: new Date() } });
  await revokeAllTrustedDevices(target.id);
  const detail = `${current} -> ${next}`;
  await audit(actor, 'ADMIN_LEVEL_CHANGE', target.id, detail);
  await logActivity({ action: 'user.admin_level_changed', level: 'warning', actorId: actor.id, actorEmail: actor.email ?? null, targetType: 'user', targetId: target.id, detail, request });
  await notify(target.id, 'admin_tier.changed', {}, '/admin');
  return { ok: true, changed: true };
}

export async function addScopeGrant(
  actor: ActorRef,
  targetId: string,
  grant: { cohortId?: string | null; companyId?: string | null },
  request?: Request,
): Promise<Outcome & { grantId?: string }> {
  const target = await targetInOrg(actor, targetId);
  if (!target || !target.orgId) return { ok: false, status: 404, code: 'not_found' };
  const refusal = grantRefusal(adminTierFor(target.role, target.adminLevel), grant);
  if (refusal) return { ok: false, status: 400, code: refusal };
  // The cohort / company must be the target's own org's — an id from another
  // tenant is the same 404 as an unknown one.
  const [cohort, company] = await Promise.all([
    grant.cohortId ? prisma.cohort.findFirst({ where: { id: grant.cohortId, orgId: target.orgId }, select: { id: true } }) : null,
    grant.companyId ? prisma.company.findFirst({ where: { id: grant.companyId, orgId: target.orgId }, select: { id: true } }) : null,
  ]);
  if ((grant.cohortId && !cohort) || (grant.companyId && !company)) return { ok: false, status: 404, code: 'outside_org' };
  try {
    const row = await prisma.adminScopeGrant.create({
      data: { userId: target.id, orgId: target.orgId, cohortId: grant.cohortId || null, companyId: grant.companyId || null, createdById: actor.id },
      select: { id: true },
    });
    const detail = `${grant.cohortId ? `cohort ${grant.cohortId}` : ''}${grant.cohortId && grant.companyId ? ' + ' : ''}${grant.companyId ? `company ${grant.companyId}` : ''}`;
    await audit(actor, 'ADMIN_SCOPE_GRANT', target.id, detail);
    await logActivity({ action: 'user.admin_scope_granted', level: 'warning', actorId: actor.id, actorEmail: actor.email ?? null, targetType: 'user', targetId: target.id, detail, request });
    return { ok: true, changed: true, grantId: row.id };
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return { ok: false, status: 409, code: 'duplicate_grant' };
    throw e;
  }
}

export async function removeScopeGrant(actor: ActorRef, grantId: string, request?: Request): Promise<Outcome> {
  const grant = await prisma.adminScopeGrant.findFirst({
    where: { id: grantId, orgId: actor.orgId ?? (await defaultOrgId()) },
    select: { id: true, userId: true, cohortId: true, companyId: true },
  });
  if (!grant) return { ok: false, status: 404, code: 'not_found' };
  await prisma.adminScopeGrant.deleteMany({ where: { id: grant.id } });
  const detail = `${grant.cohortId ? `cohort ${grant.cohortId}` : ''}${grant.cohortId && grant.companyId ? ' + ' : ''}${grant.companyId ? `company ${grant.companyId}` : ''}`;
  await audit(actor, 'ADMIN_SCOPE_REVOKE', grant.userId, detail);
  await logActivity({ action: 'user.admin_scope_revoked', level: 'warning', actorId: actor.id, actorEmail: actor.email ?? null, targetType: 'user', targetId: grant.userId, detail, request });
  return { ok: true, changed: true };
}
