import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { orgWhere } from '@/lib/tenantFilter';
import { defaultOrgId } from '@/lib/defaultOrg';
import { adminTierFor, ADMIN_TIERS } from '@/lib/authzRule';
import { isAdminTier } from '@/lib/adminTierRule';
import { addScopeGrant, changeAdminTier, removeScopeGrant } from '@/lib/adminTiers';

// Admin tiers & scope grants (#1579): who holds which tier, which cohorts and
// companies a PROGRAM_ADMIN may act in, who granted it and when.
//
// WHO: `admin.grant` — ORG_ADMIN only, through requirePermission(), the one
// permission rule (src/lib/authzRule.ts). There is no second authorization
// path here; the change guards (no self-change, never above one's own tier,
// the last active ORG_ADMIN stays) are src/lib/adminTierRule.ts, applied by
// the one writer src/lib/adminTiers.ts. A super admin acts through the same
// door: tenant permissions never cross an org (#1575).

async function gate(request: Request) {
  const g = await requirePermission('admin.grant', { request });
  if ('error' in g) return g;
  const orgId = g.actor.orgId ?? (await defaultOrgId());
  return { ...g, orgId, ref: { id: g.actor.id, email: g.session.user.email ?? null, orgId: g.actor.orgId, tier: g.actor.adminLevel } };
}

// GET — every ADMIN of the org with their effective tier and grants, plus the
// cohorts and companies a grant may name.
export async function GET(request: Request) {
  const g = await gate(request);
  if ('error' in g) return g.error;
  return withTenantScope(g.session, async () => {
    const scope = await orgWhere(g.orgId);
    const [admins, cohorts, companies] = await Promise.all([
      prisma.user.findMany({
        where: { AND: [{ role: 'ADMIN' }, scope] },
        orderBy: { fullName: 'asc' },
        select: {
          id: true,
          fullName: true,
          email: true,
          isActive: true,
          adminLevel: true,
          role: true,
          adminScopeGrants: { select: { id: true, cohortId: true, companyId: true, createdById: true, createdAt: true, cohort: { select: { name: true } }, company: { select: { name: true } } } },
        },
      }),
      prisma.cohort.findMany({ where: { orgId: g.orgId }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true } }),
      prisma.company.findMany({ where: { orgId: g.orgId }, orderBy: { name: 'asc' }, select: { id: true, name: true }, take: 500 }),
    ]);
    const granterIds = [...new Set(admins.flatMap((a) => a.adminScopeGrants.map((gr) => gr.createdById)).filter((x): x is string => !!x))];
    const granters = granterIds.length
      ? new Map((await prisma.user.findMany({ where: { id: { in: granterIds } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]))
      : new Map<string, string>();
    return NextResponse.json({
      me: g.actor.id,
      tiers: ADMIN_TIERS,
      admins: admins.map((a) => ({
        id: a.id,
        fullName: a.fullName,
        email: a.email,
        isActive: a.isActive,
        tier: adminTierFor(a.role, a.adminLevel),
        grants: a.adminScopeGrants.map((gr) => ({
          id: gr.id,
          cohortId: gr.cohortId,
          cohortName: gr.cohort?.name ?? null,
          companyId: gr.companyId,
          companyName: gr.company?.name ?? null,
          grantedBy: gr.createdById ? granters.get(gr.createdById) ?? null : null,
          grantedAt: gr.createdAt,
        })),
      })),
      cohorts,
      companies,
    });
  });
}

const tierSchema = z.object({ userId: z.string().min(1), tier: z.string() }).strict();

// PATCH { userId, tier } — change a tier. Signs the target out everywhere.
export async function PATCH(request: Request) {
  const g = await gate(request);
  if ('error' in g) return g.error;
  const parsed = tierSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isAdminTier(parsed.data.tier)) return NextResponse.json({ error: 'Validation failed', code: 'invalid_tier' }, { status: 400 });
  const { userId, tier } = parsed.data;
  return withTenantScope(g.session, async () => {
    const out = await changeAdminTier(g.ref, userId, tier, request);
    if (!out.ok) return NextResponse.json({ error: 'Refused', code: out.code }, { status: out.status });
    return NextResponse.json({ ok: true, changed: out.changed, tier });
  });
}

const grantSchema = z.object({ userId: z.string().min(1), cohortId: z.string().min(1).optional(), companyId: z.string().min(1).optional() }).strict();

// POST { userId, cohortId?, companyId? } — add a PROGRAM_ADMIN scope grant.
export async function POST(request: Request) {
  const g = await gate(request);
  if ('error' in g) return g.error;
  const parsed = grantSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  return withTenantScope(g.session, async () => {
    const out = await addScopeGrant(g.ref, parsed.data.userId, parsed.data, request);
    if (!out.ok) return NextResponse.json({ error: 'Refused', code: out.code }, { status: out.status });
    return NextResponse.json({ ok: true, grantId: out.grantId }, { status: 201 });
  });
}

// DELETE ?grantId= — remove a scope grant. Another org's grant is 404.
export async function DELETE(request: Request) {
  const g = await gate(request);
  if ('error' in g) return g.error;
  const grantId = new URL(request.url).searchParams.get('grantId');
  if (!grantId) return NextResponse.json({ error: 'grantId is required' }, { status: 400 });
  return withTenantScope(g.session, async () => {
    const out = await removeScopeGrant(g.ref, grantId, request);
    if (!out.ok) return NextResponse.json({ error: 'Refused', code: out.code }, { status: out.status });
    return NextResponse.json({ ok: true });
  });
}
