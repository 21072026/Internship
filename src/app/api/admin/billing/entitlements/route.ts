import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isSuperAdmin, isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { logActivity } from '@/lib/activity';
import { KNOWN_GRANTABLE_FEATURES } from '@/lib/plans';

// POST — grant or revoke a feature for an organization OUTSIDE its plan (#1734):
// one `OrgEntitlement` row (a pilot, the AI pack, a contractual exception).
//
// A commercial write, so a SUPER ADMIN of the target org's world only
// (isSuperAdminFor, docs/worlds.md § Super admin) — never a bare
// `role === 'ADMIN'`, which would let any tenant admin hand its own org the
// paid product. A tenant admin gets 403; a super admin of the other world gets
// 404, the same as a missing org. Every write is in the activity log.
//
// A grant only ever ADDS to what the plan includes (resolveEntitlements). It
// takes effect on the next entitled() call — nothing is cached. Revoking
// deletes the row; taking away something the plan sells is a plan change.
const NOTE_MAX = 1000;

const schema = z.object({
  orgId: z.string().min(1).max(64),
  feature: z.string().max(64),
  action: z.enum(['grant', 'revoke']),
  note: z.string().trim().max(NOTE_MAX).optional().nullable(),
  // ISO date-time; must be in the future. Omitted/null = open-ended.
  expiresAt: z.string().datetime().optional().nullable(),
});

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!(await isSuperAdmin(session))) {
    await logCrossTenantDenial(session, 'POST /api/admin/billing/entitlements', null);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { orgId, feature, action } = parsed.data;
  if (!KNOWN_GRANTABLE_FEATURES.has(feature)) {
    return NextResponse.json({ error: 'Unknown feature', code: 'unknown_feature' }, { status: 400 });
  }

  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org || !(await isSuperAdminFor(session, orgId))) {
    if (org) await logCrossTenantDenial(session, 'POST /api/admin/billing/entitlements', orgId);
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (action === 'grant') {
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ error: 'expiresAt must be in the future', code: 'expiry_in_past' }, { status: 400 });
    }
    const note = parsed.data.note || null;
    await prisma.orgEntitlement.upsert({
      where: { orgId_feature: { orgId, feature } },
      create: { orgId, feature, grantedById: session.user.id, note, expiresAt },
      update: { grantedById: session.user.id, note, expiresAt },
    });
  } else {
    await prisma.orgEntitlement.deleteMany({ where: { orgId, feature } });
  }

  await logActivity({
    action: action === 'grant' ? 'admin.org_entitlement.grant' : 'admin.org_entitlement.revoke',
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: 'organization',
    targetId: orgId,
    orgId,
    detail: action === 'grant' && parsed.data.expiresAt ? `${feature} until ${parsed.data.expiresAt}` : feature,
    request,
  });

  const grants = await prisma.orgEntitlement.findMany({
    where: { orgId },
    orderBy: { createdAt: 'asc' },
    select: { feature: true, note: true, expiresAt: true, createdAt: true },
  });
  return NextResponse.json({ ok: true, grants });
}
