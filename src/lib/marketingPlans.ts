// The published price list of the MARKETING product (SaleVali).
//
// Deliberately NOT part of src/lib/plans.ts: those plans are wired into
// subscriptions, entitlements and the billing meter (docs/metering.md), and
// the marketing product has no checkout and no plan gate. This list is what
// /pricing on the marketing host shows and what the landing FAQ quotes; a paid
// plan is invoiced after a conversation (SELF_SERVE_CHECKOUT is false), so a
// price here is an offer we stand behind, never a button that charges.
//
// Positioned at the top of the market on purpose (maintainer decision
// 2026-10-06): above Pipedrive (€14–99) and HubSpot Sales Hub Professional
// (~$90–100), level with Salesforce Sales Cloud Enterprise/Unlimited
// ($175–350). All prices are NET (plus VAT), per user per month.
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
