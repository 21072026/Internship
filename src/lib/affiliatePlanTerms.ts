// The commission plan as a partner reads it in the portal (docs/affiliate-module.md,
// "The partner portal", #3349).
//
// PURE and dependency-free: it only reshapes a validated `CommissionPlan` into the
// lines the "Your commission terms" box prints. It adds nothing the plan does not
// say and decides nothing the engine decides (`affiliateCommissionRule.ts` stays the
// only place a commission is computed). Amounts stay integer minor units; the page
// formats them.

import type { BoundaryCustomer, CommissionPlan } from './affiliateCommissionRule';

export interface PlanTermsView {
  currency: string;
  /** One-off commission bands in ascending order: a first payment up to `upToMinor` earns `commissionMinor`. */
  bands: { upToMinor: number; commissionMinor: number }[];
  /**
   * The commission for a first payment above the last band. `aboveMinor` is the last
   * band's bound, or null when the plan has no bands (then it is the commission of every first payment).
   */
  top: { aboveMinor: number | null; commissionMinor: number };
  /** The percent phase, or null when the plan has none (a rate of 0 or no switch-over customer). */
  percent: {
    bps: number;
    startsAtCustomer: number;
    boundaryCustomer: BoundaryCustomer;
    /** Months from a customer's first payment the percent applies; null = no limit. */
    windowMonths: number | null;
  } | null;
  payoutDays: number;
  /**
   * What happens once a partnership's termination takes effect, by plan shape:
   * STOP_ALL (nothing accrues), RUN_OUT_WINDOW (existing customers earn the percent
   * until their own window closes), RUN_OUT_OPEN (the same, with no window) or
   * RUN_OUT_NONE (run-out, but the plan has no percent phase, so nothing is left to earn).
   *
   * The two run-out texts are CONDITIONAL on purpose: the engine only switches to
   * percent when `switchAtCustomer` eligible customers paid before the termination, and
   * no customer can become eligible afterwards. The plan alone cannot say whether the
   * partner got there, so the wording says "if your percent phase has already started".
   */
  afterNotice: AfterNoticeTerms;
}

export type AfterNoticeTerms = 'STOP_ALL' | 'RUN_OUT_WINDOW' | 'RUN_OUT_OPEN' | 'RUN_OUT_NONE';

export function planTermsView(plan: CommissionPlan): PlanTermsView {
  const hasPercent = plan.percentBps > 0 && plan.switchAtCustomer !== null;
  return {
    currency: plan.currency,
    bands: plan.tiers.map((t) => ({ upToMinor: t.upToMinor, commissionMinor: t.commissionMinor })),
    top: {
      aboveMinor: plan.tiers.length > 0 ? plan.tiers[plan.tiers.length - 1].upToMinor : null,
      commissionMinor: plan.topCommissionMinor,
    },
    percent: hasPercent
      ? {
          bps: plan.percentBps,
          startsAtCustomer: plan.switchAtCustomer as number,
          boundaryCustomer: plan.boundaryCustomer,
          windowMonths: plan.windowMonths,
        }
      : null,
    payoutDays: plan.payoutDays,
    afterNotice:
      plan.afterNotice === 'STOP_ALL'
        ? 'STOP_ALL'
        : !hasPercent
          ? 'RUN_OUT_NONE'
          : plan.windowMonths === null
            ? 'RUN_OUT_OPEN'
            : 'RUN_OUT_WINDOW',
  };
}

/** Basis points as a percentage text with the locale's decimal mark: 1250 → "12.5", 800 → "8". */
export function bpsToPercentText(bps: number, decimalMark = '.'): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return String(whole);
  const digits = String(fraction).padStart(2, '0').replace(/0$/, '');
  return `${whole}${decimalMark}${digits}`;
}
