// The plan KEYS of the MARKETING product's price list (#2767, #2927).
//
// The prices themselves are not in the code: a marketing host shows the price
// list of the organization bound to it (`Organization.publicHost`), held as data
// in that organization's `marketingPriceList` setting (the rule:
// src/lib/marketingPriceListRule.ts). Without one, /pricing shows a neutral
// "contact us for pricing" state and the landing FAQ quotes no figure.
//
// Only the keys live here, because a plan's name, description and feature list
// are translated copy keyed by them (`mkt<Plan>Name`… in the `pricing`
// dictionary). Deliberately NOT part of src/lib/plans.ts: those plans are wired
// into subscriptions, entitlements and the billing meter (docs/metering.md), and
// the marketing product has no checkout and no plan gate.
//
// Dependency-free so the unit test can import it directly.

export const MARKETING_PLAN_KEYS = ['team', 'business', 'enterprise'] as const;
export type MarketingPlanKey = (typeof MARKETING_PLAN_KEYS)[number];
