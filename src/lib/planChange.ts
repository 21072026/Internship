// The database half of plan-change requests (#1743). The rules are pure in
// src/lib/planChangeRule.ts; this file is the only writer of PlanChangeRequest
// besides the tenant's own submit, and the only place an approved request
// moves a plan.

import { prisma } from '@/lib/prisma';
import { orgWorldWhere } from '@/lib/superAdminWorld';
import { DEFAULT_VERTICAL, type VerticalKey } from '@/lib/verticals';
import { legacyPlanFor, statusAfter, type PlanChangeAction } from '@/lib/planChangeRule';

/**
 * The operators of a world: active super admins whose own organization is in
 * it (docs/worlds.md § Super admin). A super admin with no organization belongs
 * to the default world, which is worldOfOrg()'s rule for a null org.
 */
export async function planChangeOperatorIds(world: VerticalKey): Promise<string[]> {
  const inWorld = { org: orgWorldWhere(world) };
  const rows = await prisma.user.findMany({
    where: {
      isSuperAdmin: true,
      isActive: true,
      role: 'ADMIN',
      OR: world === DEFAULT_VERTICAL ? [inWorld, { orgId: null }] : [inWorld],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export type HandleResult =
  | { ok: true; request: { id: string; orgId: string; requestedById: string; requestedPlan: string; billingCycle: string; currentPlan: string } }
  | { ok: false; reason: 'not_open' };

/**
 * Apply or reject an open request. ONE transaction: a guarded `updateMany` on
 * `status: 'NEW'` (so two operators cannot both act — the loser gets
 * `not_open`), and, for `apply`, the subscription's plan + interval and the
 * legacy `Organization.plan` in the same commit, so the entitlement resolver
 * and the old plan gate never disagree about what the tenant bought.
 *
 * `educationDiscount` is the operator's call: undefined leaves the
 * subscription's flag as it is, whatever the tenant claimed.
 */
export async function handlePlanChange(input: {
  id: string;
  action: PlanChangeAction;
  operatorId: string;
  note: string | null;
  educationDiscount?: boolean;
}): Promise<HandleResult> {
  const { id, action, operatorId, note, educationDiscount } = input;
  return prisma.$transaction(async (tx) => {
    const moved = await tx.planChangeRequest.updateMany({
      where: { id, status: 'NEW' },
      data: { status: statusAfter(action), openKey: null, handledById: operatorId, handledAt: new Date(), note },
    });
    if (moved.count === 0) return { ok: false as const, reason: 'not_open' as const };

    const request = await tx.planChangeRequest.findUniqueOrThrow({
      where: { id },
      select: { id: true, orgId: true, requestedById: true, requestedPlan: true, billingCycle: true, currentPlan: true },
    });

    if (action === 'apply') {
      const planData = {
        planKey: request.requestedPlan,
        interval: request.billingCycle,
        status: 'ACTIVE',
        ...(educationDiscount === undefined ? {} : { educationDiscount }),
      };
      await tx.subscription.upsert({
        where: { orgId: request.orgId },
        create: { orgId: request.orgId, ...planData },
        update: planData,
      });
      await tx.organization.update({
        where: { id: request.orgId },
        data: { plan: legacyPlanFor(request.requestedPlan) },
      });
    }
    return { ok: true as const, request };
  });
}
