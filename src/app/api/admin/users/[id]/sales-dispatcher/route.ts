import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requirePermission } from '@/lib/authz';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { logActivity } from '@/lib/activity';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { hasSalesSurface } from '@/lib/salesSurface';

// POST { enabled } — make a sales rep the org's sales dispatcher, or stop
// (#3656, src/lib/salesDispatcher.ts): a non-admin team lead who may see and
// work the whole tenant's sales book. Granting it widens what one rep can read
// and change across every colleague's records, so it is narrow on purpose:
//
//   * `user.write` (an ORG_ADMIN), never from an impersonation session;
//   * the target is an active MENTOR of the CALLER's own org (checked here, not
//     left to the tenant middleware, which is off in production) — another
//     org's user is the same 404 as one that does not exist;
//   * only on a vertical with the sales surface — elsewhere the flag would be
//     inert, and setting an inert power only hides it (409 `not_sales`);
//   * every change is an AuditLog row and a warning-level activity line.
//
// No session is revoked: the flag is read live on every request, so a revoke
// takes effect on the dispatcher's next request.
const schema = z.object({ enabled: z.boolean() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot change the sales dispatcher while impersonating', code: 'impersonating' }, { status: 400 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', code: 'invalid_input' }, { status: 400 });
  const { enabled } = parsed.data;

  return withTenantScope(session, async () => {
    const { id } = await params;
    const callerOrgId = resolveOrgId(session);
    const tenant = await tenantWhere(session);
    const user = await prisma.user.findFirst({
      where: withinTenant({ id }, tenant),
      select: { id: true, email: true, role: true, isActive: true, orgId: true, salesDispatcher: true },
    });
    if (!user || !callerOrgId || user.orgId !== callerOrgId) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (!hasSalesSurface('MENTOR', await shellCapabilities(callerOrgId))) {
      return NextResponse.json({ error: 'This organization has no sales board', code: 'not_sales' }, { status: 409 });
    }
    if (enabled && (user.role !== 'MENTOR' || !user.isActive)) {
      return NextResponse.json({ error: 'Only an active sales rep can be the sales dispatcher', code: 'not_a_rep' }, { status: 400 });
    }
    if (user.salesDispatcher === enabled) return NextResponse.json({ ok: true, salesDispatcher: enabled, unchanged: true });

    await prisma.$transaction([
      prisma.user.updateMany({ where: withinTenant({ id: user.id, orgId: callerOrgId }, tenant), data: { salesDispatcher: enabled } }),
      prisma.auditLog.create({
        data: { orgId: callerOrgId, actorId: session.user.id, action: enabled ? 'sales.dispatcher_granted' : 'sales.dispatcher_revoked', targetId: user.id },
      }),
    ]);
    await logActivity({
      action: enabled ? 'sales.dispatcher_granted' : 'sales.dispatcher_revoked',
      level: 'warning',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: user.id,
      detail: `${user.email} ${enabled ? 'may now' : 'may no longer'} see and work every sales record of the organization`,
      orgId: callerOrgId,
      request,
    });
    return NextResponse.json({ ok: true, salesDispatcher: enabled });
  });
}
