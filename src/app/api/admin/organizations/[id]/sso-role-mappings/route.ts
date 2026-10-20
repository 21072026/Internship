import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { recordOrgWrite } from '@/lib/orgAudit';
import { orgPlanHasFeature } from '@/lib/orgPlans';
import { isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';
import { isMappableRole, mappableRolesFor } from '@/lib/ssoRoleMapping';
import { verticalCapabilities } from '@/lib/verticals';

// A tenant's IdP role mapping (#1940): "a user whose `claim` contains
// `matchValue` gets `role`", plus the opt-in `ssoSyncRole` switch. The rule
// that reads these rows is src/lib/ssoRoleMapping.ts; the ACS route applies it.
//
// WHO MAY WRITE: exactly who may write the org's SSO config — its own ADMIN, or
// a super admin of its world (#1535, the parent route's rule). The refusal comes
// before the lookup, so a foreign id is never confirmed.
//
// NO ADMIN MAPPING. `role` is one of MAPPABLE_ROLES; ADMIN is refused here (and
// ignored by resolveRole) until the platform gate #1575 lands — mapping a claim
// to ADMIN turns any gap in who may edit an org's SSO config into remote
// privilege escalation.
//
// ONLY THE VERTICAL'S ROLES (#2839). GET offers, and POST accepts, exactly
// `mappableRolesFor(verticalCapabilities(org.vertical))`: a MARKETING tenant
// never sees SOURCE, because that product has no `sourcing` module and a user
// provisioned into the role would have no shell. The ACS applies the same list.
//
// Not wrapped in withTenantScope, for the reason pipeline-stages gives: a super
// admin manages another tenant by explicit id. Every query names `orgId: id`.

async function requireAdminOrg(id: string, route: string) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return { error: 'Unauthorized' as const, status: 401 };
  if (!(await isSuperAdminFor(session, id))) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId || ownOrgId !== id) {
      await logCrossTenantDenial(session, route, id);
      return { error: 'Forbidden' as const, status: 403 };
    }
  }
  const org = await prisma.organization.findUnique({
    where: { id },
    select: { id: true, plan: true, ssoSyncRole: true, vertical: true },
  });
  if (!org) return { error: 'Organization not found' as const, status: 404 };
  return { org, session };
}

const mappingSelect = { id: true, claim: true, matchValue: true, role: true, priority: true, createdAt: true } as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAdminOrg(id, 'GET /api/admin/organizations/[id]/sso-role-mappings');
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const mappings = await prisma.ssoClaimMapping.findMany({
    where: { orgId: id },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    select: mappingSelect,
  });
  return NextResponse.json({
    mappings,
    syncRole: gate.org.ssoSyncRole,
    roles: mappableRolesFor(verticalCapabilities(gate.org.vertical)),
  });
}

const createSchema = z.object({
  claim: z.string().trim().min(1).max(191),
  matchValue: z.string().trim().min(1).max(191),
  role: z.string().min(1).max(20),
  priority: z.number().int().min(-100).max(100).default(0),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAdminOrg(id, 'POST /api/admin/organizations/[id]/sso-role-mappings');
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  if (!orgPlanHasFeature(gate.org.plan, 'SSO_SAML')) {
    return NextResponse.json({ error: 'SSO is not part of this plan', code: 'plan_feature_required' }, { status: 403 });
  }
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { claim, matchValue, role, priority } = parsed.data;
  const offered = mappableRolesFor(verticalCapabilities(gate.org.vertical));
  if (!(offered as readonly string[]).includes(role)) {
    const refusal = role === 'ADMIN'
      ? { error: 'Mapping an IdP claim to ADMIN is not available yet.', code: 'admin_mapping_unavailable' }
      : isMappableRole(role)
        ? { error: 'That role is not part of this product.', code: 'role_not_in_vertical' }
        : { error: 'Unknown role.', code: 'invalid_role' };
    return NextResponse.json(refusal, { status: 400 });
  }
  try {
    const mapping = await prisma.ssoClaimMapping.create({
      data: { orgId: id, claim, matchValue, role, priority },
      select: mappingSelect,
    });
    await recordOrgWrite({
      orgId: id,
      action: 'sso.role_mapping_created',
      actorId: gate.session.user.id,
      actorEmail: gate.session.user.email ?? null,
      targetType: 'ssoClaimMapping',
      targetId: mapping.id,
      detail: `${claim} = ${matchValue} -> ${role} (priority ${priority})`,
      request,
    });
    return NextResponse.json({ mapping }, { status: 201 });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return NextResponse.json({ error: 'That claim value is already mapped', code: 'duplicate_mapping' }, { status: 409 });
    }
    throw e;
  }
}

const patchSchema = z.object({ syncRole: z.boolean() }).strict();

// PATCH — the opt-in re-evaluation switch (Organization.ssoSyncRole).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAdminOrg(id, 'PATCH /api/admin/organizations/[id]/sso-role-mappings');
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  if (parsed.data.syncRole && !orgPlanHasFeature(gate.org.plan, 'SSO_SAML')) {
    return NextResponse.json({ error: 'SSO is not part of this plan', code: 'plan_feature_required' }, { status: 403 });
  }
  await prisma.organization.update({ where: { id }, data: { ssoSyncRole: parsed.data.syncRole } });
  await recordOrgWrite({
    orgId: id,
    action: 'sso.role_sync_toggled',
    level: 'warning',
    actorId: gate.session.user.id,
    actorEmail: gate.session.user.email ?? null,
    detail: `ssoSyncRole ${gate.org.ssoSyncRole} -> ${parsed.data.syncRole}`,
    request,
  });
  return NextResponse.json({ syncRole: parsed.data.syncRole });
}

// DELETE ?mappingId= — remove one rule. Scoped to this org, so an id from
// another tenant deletes nothing and answers 404.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireAdminOrg(id, 'DELETE /api/admin/organizations/[id]/sso-role-mappings');
  if ('error' in gate) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const mappingId = new URL(request.url).searchParams.get('mappingId');
  if (!mappingId) return NextResponse.json({ error: 'mappingId is required' }, { status: 400 });
  const removed = await prisma.ssoClaimMapping.deleteMany({ where: { id: mappingId, orgId: id } });
  if (removed.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await recordOrgWrite({
    orgId: id,
    action: 'sso.role_mapping_deleted',
    actorId: gate.session.user.id,
    actorEmail: gate.session.user.email ?? null,
    targetType: 'ssoClaimMapping',
    targetId: mappingId,
    request,
  });
  return NextResponse.json({ ok: true });
}
