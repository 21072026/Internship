import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { recordOrgWrite } from '@/lib/orgAudit';
import { isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { resolveOrgId } from '@/lib/orgScope';
import { requirePermission, type Permission } from '@/lib/authz';
import { effectivePolicy, isImpersonationPolicy } from '@/lib/impersonationPolicyRule';

// An organization's impersonation policy (#1586): full | read_only | off, the
// rule in src/lib/impersonationPolicyRule.ts. Enforced where an admin STARTS
// "log in as" (POST /api/admin/impersonate, against the TARGET's org) and, for
// read_only, by one central write refusal in src/middleware.ts.
//
// WHO: the org's own ADMIN (`org.settings.*`) or a super admin of its world —
// the sibling sso-role-mappings route's gate. The refusal comes before the
// lookup, so a foreign id is never confirmed.
//
// Not wrapped in withTenantScope: a super admin manages another tenant by
// explicit id, and every query names `id`.

async function orgGate(id: string, route: string, permission: Permission, request: Request) {
  const gate = await requirePermission(permission, { request });
  if ('error' in gate) return gate;
  const { session } = gate;
  if (!(await isSuperAdminFor(session, id))) {
    const ownOrgId = resolveOrgId(session);
    if (!ownOrgId || ownOrgId !== id) {
      await logCrossTenantDenial(session, route, id);
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
  }
  const org = await prisma.organization.findUnique({ where: { id }, select: { id: true, impersonationPolicy: true } });
  if (!org) return { error: NextResponse.json({ error: 'Organization not found' }, { status: 404 }) };
  return { org, session };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await orgGate(id, 'GET /api/admin/organizations/[id]/impersonation-policy', 'org.settings.read', request);
  if ('error' in g) return g.error;
  return NextResponse.json({ policy: effectivePolicy(g.org.impersonationPolicy) });
}

const schema = z.object({ policy: z.string() }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await orgGate(id, 'PATCH /api/admin/organizations/[id]/impersonation-policy', 'org.settings.write', request);
  if ('error' in g) return g.error;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isImpersonationPolicy(parsed.data.policy)) {
    return NextResponse.json({ error: 'Unknown policy', code: 'invalid_policy' }, { status: 400 });
  }
  const before = effectivePolicy(g.org.impersonationPolicy);
  await prisma.organization.update({ where: { id }, data: { impersonationPolicy: parsed.data.policy } });
  await recordOrgWrite({
    orgId: id,
    action: 'org.impersonation_policy_changed',
    level: 'warning',
    actorId: g.session.user.id,
    actorEmail: g.session.user.email ?? null,
    detail: `impersonationPolicy ${before} -> ${parsed.data.policy}`,
    request,
  });
  return NextResponse.json({ policy: parsed.data.policy });
}
