// The BUILT-IN price list of the MARKETING product — the fallback of the
// per-organization price list (#2927).
//
// A marketing host shows the price list of the organization bound to it
// (`Organization.publicHost`), held as data in that organization's
// `marketingPriceList` setting (the rule: src/lib/marketingPriceListRule.ts).
// This list is what /pricing and the landing FAQ show when no organization is
// bound to the host or the bound one has no list of its own. It stays until the
// data is in place everywhere; a later change removes it.
//
// Deliberately NOT part of src/lib/plans.ts: those plans are wired into
// subscriptions, entitlements and the billing meter (docs/metering.md), and
// the marketing product has no checkout and no plan gate. A paid plan is
// invoiced after a conversation (SELF_SERVE_CHECKOUT is false), so a price here
// is an offer, never a button that charges. All prices are NET (plus VAT), per
// user per month.
//
// Dependency-free so the unit test can import it directly.

export const MARKETING_PLAN_KEYS = ['team', 'business', 'enterprise'] as const;
export type MarketingPlanKey = (typeof MARKETING_PLAN_KEYS)[number];

export interface MarketingPlan {
  key: MarketingPlanKey;
  /** Per user per month, billed annually (EUR, net). */
  annualSeatEur: number;
  /** Per user per month on a month-to-month contract; null = annual only. */
  monthlySeatEur: number | null;
  /** The smallest team the plan is sold to. */
  minSeats: number;
  /** One-time onboarding fee (EUR, net); 0 = none. */
  onboardingEur: number;
}

export const MARKETING_PLANS: readonly MarketingPlan[] = [
  { key: 'team', annualSeatEur: 149, monthlySeatEur: 179, minSeats: 3, onboardingEur: 0 },
  { key: 'business', annualSeatEur: 249, monthlySeatEur: 299, minSeats: 5, onboardingEur: 2900 },
  { key: 'enterprise', annualSeatEur: 390, monthlySeatEur: null, minSeats: 10, onboardingEur: 6900 },
];

/** The "from" price the landing FAQ quotes: the cheapest annual seat. */
export function marketingFromSeatEur(): number {
  return Math.min(...MARKETING_PLANS.map((p) => p.annualSeatEur));
}

/** What the smallest team pays per year on a plan's annual contract, onboarding included. */
export function marketingFirstYearMinimumEur(plan: MarketingPlan): number {
  return plan.annualSeatEur * 12 * plan.minSeats + plan.onboardingEur;
}
