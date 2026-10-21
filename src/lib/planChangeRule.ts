// The rules of a plan-change request (#1743), dependency-free so the unit test
// (scripts/test/plan-change.test.mjs) loads them under plain `node --test`.
//
// Which plans may be requested, on which interval, and what an applied change
// writes to the legacy `Organization.plan` column — all here, and nowhere else.
// The route handlers (src/app/api/org/plan-change, src/app/api/admin/plan-requests)
// only read the database and call these.
//
// SCOPE: the programme side only. src/lib/plans.ts is the internship product's
// price list; the MARKETING product has its own keys (src/lib/marketingPlans.ts)
// and no plan gate or checkout, so a request names a PROGRAM-audience plan and
// the tenant route refuses an org without the `mentorship` capability.

import { BILLING_INTERVALS, getPlan, plansForAudience, type BillingInterval, type PlanKey } from '@/lib/plans';

export const PLAN_CHANGE_STATUSES = ['NEW', 'APPLIED', 'REJECTED'] as const;
export type PlanChangeStatus = (typeof PLAN_CHANGE_STATUSES)[number];

export const PLAN_CHANGE_ACTIONS = ['apply', 'reject'] as const;
export type PlanChangeAction = (typeof PLAN_CHANGE_ACTIONS)[number];

/** Free-text caps; both columns are TEXT, so the cap is a product limit, not a width. */
export const PLAN_CHANGE_REASON_MAX = 2000;
export const PLAN_CHANGE_NOTE_MAX = 2000;

/** The plans a tenant may ask for: the programme-side price list, in published order. */
export const REQUESTABLE_PLAN_KEYS: readonly PlanKey[] = plansForAudience('PROGRAM').map((p) => p.key);

export type PlanChangeRefusal = 'unknown_plan' | 'same_plan' | 'interval_not_sold';

/**
 * Why a request may not be made, or null when it may. `currentPlan` and
 * `currentInterval` are the tenant's subscription as stored.
 *
 * - `unknown_plan`: not a PROGRAM plan (an employer plan, a typo, a marketing key).
 * - `same_plan`: the plan AND the interval it is already on — nothing to change.
 *   Same plan on the other interval is a real request (monthly → annual).
 * - `interval_not_sold`: the plan has no price on that interval (Enterprise is
 *   annual-only); the operator could not apply it as asked.
 */
export function planChangeRefusal(input: {
  requestedPlan: unknown;
  billingCycle: unknown;
  currentPlan: string;
  currentInterval: string;
}): PlanChangeRefusal | null {
  const { requestedPlan, billingCycle } = input;
  if (typeof requestedPlan !== 'string' || !(REQUESTABLE_PLAN_KEYS as readonly string[]).includes(requestedPlan)) {
    return 'unknown_plan';
  }
  if (typeof billingCycle !== 'string' || !(BILLING_INTERVALS as readonly string[]).includes(billingCycle)) {
    return 'interval_not_sold';
  }
  if (requestedPlan === input.currentPlan && billingCycle === input.currentInterval) return 'same_plan';
  const plan = getPlan(requestedPlan);
  if (!plan || plan.prices[billingCycle as BillingInterval] == null) return 'interval_not_sold';
  return null;
}

/**
 * The legacy `Organization.plan` value an applied plan writes, so the four
 * planGate call sites that still read that column (src/lib/orgPlans.ts) agree
 * with the subscription. Program Plus lands on ENTERPRISE because white-label
 * and SSO — what it adds over Program — are ENTERPRISE-only in the legacy map;
 * writing PRO would sell a feature the old gate then refuses.
 */
export function legacyPlanFor(planKey: string): 'FREE' | 'PRO' | 'ENTERPRISE' {
  switch (planKey) {
    case 'program':
      return 'PRO';
    case 'program_plus':
    case 'enterprise':
      return 'ENTERPRISE';
    default:
      return 'FREE';
  }
}

/** Only an open request can be handled; a handled one is a record. */
export function isOpenRequest(status: string): boolean {
  return status === 'NEW';
}

/** The status an operator action leaves a request in. */
export function statusAfter(action: PlanChangeAction): PlanChangeStatus {
  return action === 'apply' ? 'APPLIED' : 'REJECTED';
}
