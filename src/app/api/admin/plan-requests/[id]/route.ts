import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isSuperAdmin, isSuperAdminFor, logCrossTenantDenial } from '@/lib/superAdmin';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { getPlan } from '@/lib/plans';
import { handlePlanChange } from '@/lib/planChange';
import { PLAN_CHANGE_ACTIONS, PLAN_CHANGE_NOTE_MAX } from '@/lib/planChangeRule';
import { requirePermission } from '@/lib/authz';

// PATCH — an operator applies or rejects one open plan-change request (#1743).
//
// Super admins of the request's org's world only (isSuperAdminFor). A tenant
// admin gets 403; a super admin of the OTHER world gets 404, the same answer
// as a missing id, so the queue never confirms another world's request ids.
// Applying moves the subscription and the legacy Organization.plan in one
// transaction (src/lib/planChange.ts); a request somebody else already
// handled answers 409.
const patchSchema = z.object({
  action: z.enum(PLAN_CHANGE_ACTIONS),
  note: z.string().trim().max(PLAN_CHANGE_NOTE_MAX).optional().nullable(),
  // The operator's decision on the discount, independent of the tenant's
  // claim. Omitted = leave the subscription's flag as it is.
  educationDiscount: z.boolean().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // A super admin is always an ADMIN; the role check comes first so a lesser
  // role never reaches the flag lookup at all.
  const gate = await requirePermission('org.settings.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const { id } = await params;

  if (!(await isSuperAdmin(session))) {
    await logCrossTenantDenial(session, 'PATCH /api/admin/plan-requests/[id]', null);
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const existing = await prisma.planChangeRequest.findUnique({ where: { id }, select: { orgId: true } });
  if (!existing || !(await isSuperAdminFor(session, existing.orgId))) {
    if (existing) await logCrossTenantDenial(session, 'PATCH /api/admin/plan-requests/[id]', existing.orgId);
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }
  const { action, educationDiscount } = parsed.data;
  const note = parsed.data.note || null;
  // A rejection is read by the tenant: it must say why.
  if (action === 'reject' && !note) {
    return NextResponse.json({ error: 'A rejection needs a note', code: 'note_required' }, { status: 400 });
  }

  const result = await handlePlanChange({ id, action, operatorId: session.user.id, note, educationDiscount });
  if (!result.ok) return NextResponse.json({ error: 'Already handled', code: 'not_open' }, { status: 409 });

  const r = result.request;
  await logActivity({
    action: action === 'apply' ? 'org.plan_change_applied' : 'org.plan_change_rejected',
    actorId: session.user.id,
    actorEmail: session.user.email,
    targetType: 'organization',
    targetId: r.orgId,
    orgId: r.orgId,
    detail: `${r.currentPlan} → ${r.requestedPlan}/${r.billingCycle}${educationDiscount === undefined ? '' : ` (education discount ${educationDiscount ? 'on' : 'off'})`}`,
    request,
  });
  const plan = getPlan(r.requestedPlan)?.name ?? r.requestedPlan;
  await notify(r.requestedById, action === 'apply' ? 'plan_change.applied' : 'plan_change.rejected', { plan }, '/admin/billing');

  return NextResponse.json({ ok: true, status: action === 'apply' ? 'APPLIED' : 'REJECTED' });
}
