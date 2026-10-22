// What a tenant admin reads on /admin/billing (#1739): their own plan, this
// month's active pairs against the plan's band, and twelve months of history.
//
// PURE: the route (src/app/api/org/billing/route.ts) reads the Subscription row
// and the UsageRollup rows and hands them here; nothing in this file touches a
// database or a clock, so the over-band arithmetic is unit-tested
// (scripts/test/billing-summary.test.mjs) rather than discovered on an invoice.
//
// Every number comes from somewhere else on purpose — prices, bands and the
// overage rate from src/lib/plans.ts, the pair count from the UsageRollup ledger
// the nightly job writes with activeMatchedPairs() (docs/metering.md). This file
// only puts them side by side. A request path never computes the pair count:
// the definition is a scan across seven activity tables, which is the rollup's
// job, so a month without a rollup row yet reads `null` ("not computed yet"),
// never a live count.

import {
  annualMonthlyEur,
  getPlan,
  overagePerPairCents,
  planLimits,
  statusCarriesPlan,
  FREE_PLAN_KEY,
  EDUCATION_DISCOUNT_RATE,
} from '@/lib/plans';
import { previousPeriod, type Period } from '@/lib/meteringRules';

export const BILLING_HISTORY_MONTHS = 12;

/** The two UsageRollup metrics the billing screen reads. */
export const BILLING_METRICS = ['ACTIVE_MATCHED_PAIRS', 'ADMIN_SEATS'] as const;

export interface BillingSubscriptionInput {
  planKey: string;
  status: string;
  interval: string;
  educationDiscount: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
}

export interface BillingRollupInput {
  metric: string;
  period: string;
  value: number;
  computedAt: string;
}

export interface BillingMonth {
  period: Period;
  activePairs: number | null;
  adminSeats: number | null;
}

export interface BillingSummary {
  plan: {
    key: string;
    name: string;
    // False when the stored key is not a published plan: the screen then shows
    // the free tier it resolves to, and says so, instead of an unknown name.
    published: boolean;
  };
  billingCycle: string;
  status: string;
  // False for CANCELED/INCOMPLETE — the plan's features are not carried then.
  statusCarriesPlan: boolean;
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: string | null;
  educationDiscount: boolean;
  // Active pairs included per month; null = unlimited (no band).
  band: number | null;
  adminSeatLimit: number | null;
  currentPeriod: {
    period: Period;
    // null until the nightly rollup has written the month.
    activePairs: number | null;
    adminSeats: number | null;
    computedAt: string | null;
    overBand: number;
    // What the pairs over the band cost at the published overage rate; null
    // when the plan has no overage to quote (Community's cap is hard,
    // Enterprise has no band).
    overageCents: number | null;
  };
  // Newest first, exactly BILLING_HISTORY_MONTHS entries, the current month
  // included; a month without a rollup row reads null, never 0.
  history: BillingMonth[];
  pricing: {
    // Whole EUR, net of VAT, with the education discount applied when the
    // subscription carries it. null = not sold on that interval.
    monthlyEur: number | null;
    annualMonthlyEur: number | null;
    annualTotalEur: number | null;
    overagePerPairCents: number | null;
  };
}

/** The `count` periods ending with `period`, newest first. */
export function trailingPeriods(period: Period, count: number = BILLING_HISTORY_MONTHS): Period[] {
  const out: Period[] = [];
  let p = period;
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = previousPeriod(p);
  }
  return out;
}

/** Pairs over the band; 0 for an unlimited plan or a month not computed yet. */
export function pairsOverBand(activePairs: number | null, band: number | null): number {
  if (activePairs == null || band == null) return 0;
  return Math.max(0, activePairs - band);
}

function discounted(price: number | null, educationDiscount: boolean): number | null {
  if (price == null) return null;
  return educationDiscount ? Math.round(price * (1 - EDUCATION_DISCOUNT_RATE)) : price;
}

export function buildBillingSummary(input: {
  subscription: BillingSubscriptionInput;
  rollups: readonly BillingRollupInput[];
  period: Period;
}): BillingSummary {
  const { subscription: sub, rollups, period } = input;
  const published = getPlan(sub.planKey);
  // An unknown key resolves to the programme-side free tier, the same fallback
  // resolveEntitlements() uses — never to "unlimited".
  const plan = published ?? getPlan(FREE_PLAN_KEY.PROGRAM)!;
  const limits = planLimits(plan.key);

  const byKey = new Map<string, BillingRollupInput>();
  for (const r of rollups) byKey.set(`${r.metric}|${r.period}`, r);
  const value = (metric: (typeof BILLING_METRICS)[number], p: Period) => byKey.get(`${metric}|${p}`)?.value ?? null;

  const history = trailingPeriods(period).map((p) => ({
    period: p,
    activePairs: value('ACTIVE_MATCHED_PAIRS', p),
    adminSeats: value('ADMIN_SEATS', p),
  }));

  const current = history[0];
  const band = limits.activePairs;
  const overBand = pairsOverBand(current.activePairs, band);
  const rate = overagePerPairCents(plan.key);

  return {
    plan: { key: plan.key, name: plan.name, published: published != null },
    billingCycle: sub.interval,
    status: sub.status,
    statusCarriesPlan: statusCarriesPlan(sub.status),
    renewsAt: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    trialEndsAt: sub.trialEndsAt,
    educationDiscount: sub.educationDiscount,
    band,
    adminSeatLimit: limits.adminSeats,
    currentPeriod: {
      period,
      activePairs: current.activePairs,
      adminSeats: current.adminSeats,
      computedAt: byKey.get(`ACTIVE_MATCHED_PAIRS|${period}`)?.computedAt ?? null,
      overBand,
      overageCents: rate == null ? null : overBand * rate,
    },
    history,
    pricing: {
      monthlyEur: discounted(plan.prices.MONTHLY, sub.educationDiscount),
      annualMonthlyEur: discounted(annualMonthlyEur(plan.key), sub.educationDiscount),
      annualTotalEur: discounted(plan.prices.YEARLY, sub.educationDiscount),
      overagePerPairCents: rate,
    },
  };
}

// ── Included features (#1734) ───────────────────────────────────────────────

export interface BillingFeatureRow {
  key: string;
  // 'plan' = included in the subscription's plan while its status carries it;
  // 'override' = an OrgEntitlement granted on top (a pilot, an add-on).
  source: 'plan' | 'override';
  // A time-boxed grant's end; null for a plan feature or an open-ended grant.
  expiresAt: string | null;
}

/**
 * The features a tenant may use, each marked with where it comes from. Built
 * from the resolver's own split (resolveEntitlements: fromPlan / fromGrant), so
 * a feature the plan already includes is never listed twice and an unknown
 * grant key never appears; `grants` only supplies each grant's expiry.
 */
export function billingFeatureRows(
  resolution: { fromPlan: readonly string[]; fromGrant: readonly string[] },
  grants: readonly { feature: string; expiresAt: string | null }[],
): BillingFeatureRow[] {
  const expiry = new Map(grants.map((g) => [g.feature, g.expiresAt]));
  return [
    ...resolution.fromPlan.map((key) => ({ key, source: 'plan' as const, expiresAt: null })),
    ...resolution.fromGrant.map((key) => ({ key, source: 'override' as const, expiresAt: expiry.get(key) ?? null })),
  ];
}
