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
import { LEAD_OWNER_ROLES } from '@/lib/leadOwner';

// POST { enabled } — whether colleagues may hand MARKETING leads to this person
// (#3979, `User.acceptsLeadHandoffs`, src/lib/leadHandoffRule.ts
// mayReceiveHandoff). An org admin turns it off for someone who only manages or
// is away for a while: they leave the hand-off strip and dialog, and the
// hand-off write refuses them (409 recipient_not_accepting). Their own records
// stay where they are.
//
//   * `user.write` (an ORG_ADMIN), never from an impersonation session — the
//     same door as the sales dispatcher toggle next to it;
//   * the target is a lead owner (ADMIN/MENTOR) of the CALLER's own org; another
//     org's user is the same 404 as one that does not exist;
//   * only on a vertical with the sales surface (409 `not_sales`);
//   * every change is an AuditLog row and an activity line.
const schema = z.object({ enabled: z.boolean() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission('user.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Cannot change lead hand-offs while impersonating', code: 'impersonating' }, { status: 400 });
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
      select: { id: true, email: true, role: true, orgId: true, acceptsLeadHandoffs: true },
    });
    if (!user || !callerOrgId || user.orgId !== callerOrgId) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (!hasSalesSurface('MENTOR', await shellCapabilities(callerOrgId))) {
      return NextResponse.json({ error: 'This organization has no sales board', code: 'not_sales' }, { status: 409 });
    }
    if (!(LEAD_OWNER_ROLES as readonly string[]).includes(user.role)) {
      return NextResponse.json({ error: 'Only a sales rep or an admin can take leads', code: 'not_a_rep' }, { status: 400 });
    }
    if (user.acceptsLeadHandoffs === enabled) return NextResponse.json({ ok: true, acceptsLeadHandoffs: enabled, unchanged: true });

    const action = enabled ? 'sales.handoffs_opened' : 'sales.handoffs_closed';
    await prisma.$transaction([
      prisma.user.updateMany({ where: withinTenant({ id: user.id, orgId: callerOrgId }, tenant), data: { acceptsLeadHandoffs: enabled } }),
      prisma.auditLog.create({ data: { orgId: callerOrgId, actorId: session.user.id, action, targetId: user.id } }),
    ]);
    await logActivity({
      action,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: user.id,
      detail: `${user.email} ${enabled ? 'may again' : 'may no longer'} be handed leads by colleagues`,
      orgId: callerOrgId,
      request,
    });
    return NextResponse.json({ ok: true, acceptsLeadHandoffs: enabled });
  });
}
