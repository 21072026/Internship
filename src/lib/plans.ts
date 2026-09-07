// The plan → feature matrix: what each plan sells (#1731, epic #1727).
//
// THIS FILE IS THE SINGLE SOURCE OF THE PACKAGING. Prices, limits and the set
// of premium features per plan are all here and nowhere else, so "which plan
// includes white-label" has exactly one answer — for the pricing page, the
// upgrade prompt behind a 403, the admin billing screen and the server-side
// entitlement check alike.
//
// PURE AND DATA-ONLY, on purpose:
//   • no `@prisma/client`, no `@/lib/prisma`, no server-only import — the
//     pricing page and the admin billing screen are client components;
//   • no `Date`, no `Date.now()` — nothing here depends on a clock, so every
//     rule in it is unit-testable (scripts/test/plans.test.mjs) and gives the
//     same answer on the server and in the browser. Time-boxed grants are
//     filtered by the DB layer (src/lib/subscription.ts) BEFORE they reach
//     resolveEntitlements() for exactly that reason.
// Only `import type` is allowed, because a type import is erased and cannot
// drag a runtime dependency in.
//
// Nothing in this file gates anything yet. `Organization.plan` and
// src/lib/orgPlans.ts still drive the four existing planGate call sites;
// migrating those onto this matrix is a later task in the epic. Landing the
// matrix without changing behaviour is deliberate. Until then both files
// export a `planLimits()` — this one takes a plan KEY ('program'), the old one
// the legacy OrgPlan enum ('PRO') — so a caller that needs both must alias one
// on import rather than assume they are interchangeable.
//
// The numbers are the PUBLISHED ones (docs/research/competitive-analysis-2026-08.md
// § 9.3, docs/marketing/go-to-market.md): Community €0 → Program €149/mo billed
// annually → Program Plus €399/mo annually → Enterprise €749/mo, annual only.
// If packaging changes it changes there first and here second.

import type { PremiumFeature } from '@/lib/entitlementsCatalog';

// ── Vocabulary ───────────────────────────────────────────────────────────────
// These are the legal values of the String columns on `Subscription`. They are
// strings and not Prisma enums because this repo deploys with
// `prisma db push --accept-data-loss`, which resolves a MySQL ENUM change as
// DROP + CREATE (see the model's header comment).

export const PLAN_KEYS = [
  'community',
  'program',
  'program_plus',
  'enterprise',
  'employer_free',
  'employer',
  'employer_plus',
] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

export const BILLING_INTERVALS = ['MONTHLY', 'YEARLY'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

export const SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// Two wallets, sold to two different buyers and never mixed (the programme
// owner pays for the programme; a hiring company pays for its own hiring
// surface). A plan belongs to exactly one of them, which is what keeps a
// "cheapest plan including feature X" answer from offering a university an
// employer plan.
export const PLAN_AUDIENCES = ['PROGRAM', 'EMPLOYER'] as const;
export type PlanAudience = (typeof PLAN_AUDIENCES)[number];

// ── Limits ───────────────────────────────────────────────────────────────────
// `null` = unlimited. `0` = the meter does not apply to this plan at all (an
// employer plan owns no mentoring pairs); it is 0 rather than null so that a
// careless read can never report "unlimited" for a meter nobody sells.
export interface PlanLimits {
  // Monthly ACTIVE MATCHED PAIRS — the one metering unit of the programme side
  // (#1750 computes it). Mentors and mentees are never a billable unit.
  activePairs: number | null;
  // Seats that can administer the tenant. Mentor and mentee accounts are free
  // and uncounted, forever.
  adminSeats: number | null;
  // Hiring companies in the talent pool.
  companies: number | null;
  // Concurrent programmes / cohorts. We never charge per programme above the
  // free tier and say so out loud, hence the early jump to unlimited.
  programs: number | null;
  // Announcement + newsletter recipients per calendar month. A cap on the
  // sending domain's reputation as much as on the plan.
  monthlyBroadcastRecipients: number | null;
  // Admin-side AI calls per month, applicable only once the AI pack is granted
  // (it is a paid add-on, not part of any plan — see PLAN_FEATURES). All
  // participant-facing AI is free at every tier and is not metered here.
  aiCallsPerMonth: number | null;
}

// ── Features per plan ────────────────────────────────────────────────────────
// Keys come from PREMIUM_FEATURES (src/lib/entitlementsCatalog.ts). A feature
// that no plan lists is sold as an add-on or a pilot and is granted per tenant
// through an `OrgEntitlement` row — AI_PACKAGE is exactly that (published as a
// €49/mo per-org pack, so folding it into a tier here would give it away).
const PLAN_FEATURES: Record<PlanKey, readonly PremiumFeature[]> = {
  // The trial that never ends: pipeline board and basic analytics, nothing
  // premium. Also the fallback for an unknown or non-entitling subscription,
  // which is why it must stay empty.
  community: [],
  // "Full analytics + XLSX/CSV export + scheduled report email".
  program: ['ADVANCED_ANALYTICS', 'REPORT_EXPORT'],
  // Adds the two org-scope features the premium model puts above Program:
  // white-label incl. custom domain, and SSO.
  program_plus: ['ADVANCED_ANALYTICS', 'REPORT_EXPORT', 'WHITE_LABEL', 'SSO_SAML'],
  // Enterprise buys assurances, not extra feature flags: EU-only hosting, DPA,
  // SLA, audit export, named onboarding. Feature-wise it is Program Plus.
  enterprise: ['ADVANCED_ANALYTICS', 'REPORT_EXPORT', 'WHITE_LABEL', 'SSO_SAML'],
  // Employer side. Free: a brand page and answering a mentor-gated shortlist.
  employer_free: [],
  employer: ['TALENT_POOL_SEARCH', 'VERIFIED_CANDIDATE_CARD', 'COMPANY_NEED_MATCH_ALERTS'],
  employer_plus: [
    'TALENT_POOL_SEARCH',
    'VERIFIED_CANDIDATE_CARD',
    'COMPANY_NEED_MATCH_ALERTS',
    'ADVANCED_ANALYTICS',
    'REPORT_EXPORT',
    'EARLY_ACCESS',
  ],
};

export interface Plan {
  key: PlanKey;
  audience: PlanAudience;
  // Product name as published. NOT a translated label: the plan names are the
  // same in EN/TR/DE on the pricing page, so there is nothing to translate and
  // no dictionary key to drift.
  name: string;
  features: readonly PremiumFeature[];
  limits: PlanLimits;
  // Amount charged per interval in whole EUR, net of VAT: MONTHLY is per
  // month, YEARLY is per year (the annual saving is baked into the yearly
  // number, it is not a discount applied on top). `null` = the plan is not
  // sold on that interval — Enterprise is annual-only, by design.
  prices: Record<BillingInterval, number | null>;
}

export const PLANS: readonly Plan[] = [
  {
    key: 'community',
    audience: 'PROGRAM',
    name: 'Community',
    features: PLAN_FEATURES.community,
    limits: {
      activePairs: 25,
      adminSeats: 2,
      companies: 3,
      programs: 1,
      monthlyBroadcastRecipients: 250,
      aiCallsPerMonth: 0,
    },
    prices: { MONTHLY: 0, YEARLY: 0 },
  },
  {
    key: 'program',
    audience: 'PROGRAM',
    name: 'Program',
    features: PLAN_FEATURES.program,
    limits: {
      activePairs: 100,
      adminSeats: 5,
      companies: null,
      programs: null,
      monthlyBroadcastRecipients: 2_000,
      aiCallsPerMonth: 500,
    },
    // €149/mo billed annually (€1 788/yr) or €189/mo monthly.
    prices: { MONTHLY: 189, YEARLY: 1_788 },
  },
  {
    key: 'program_plus',
    audience: 'PROGRAM',
    name: 'Program Plus',
    features: PLAN_FEATURES.program_plus,
    limits: {
      activePairs: 400,
      adminSeats: 15,
      companies: null,
      programs: null,
      monthlyBroadcastRecipients: 10_000,
      aiCallsPerMonth: 2_000,
    },
    // €399/mo annually (€4 788/yr) or €479 monthly.
    prices: { MONTHLY: 479, YEARLY: 4_788 },
  },
  {
    key: 'enterprise',
    audience: 'PROGRAM',
    name: 'Enterprise',
    features: PLAN_FEATURES.enterprise,
    limits: {
      activePairs: null,
      adminSeats: null,
      companies: null,
      programs: null,
      monthlyBroadcastRecipients: null,
      aiCallsPerMonth: null,
    },
    // €749/mo, annual only — €8 988/yr, printed on the website. The published
    // sub-€9 000 top tier IS the campaign; do not raise it here.
    prices: { MONTHLY: null, YEARLY: 8_988 },
  },
  {
    key: 'employer_free',
    audience: 'EMPLOYER',
    name: 'Employer Free',
    features: PLAN_FEATURES.employer_free,
    limits: {
      activePairs: 0,
      adminSeats: 1,
      companies: 1,
      programs: 0,
      monthlyBroadcastRecipients: 0,
      aiCallsPerMonth: 0,
    },
    prices: { MONTHLY: 0, YEARLY: 0 },
  },
  {
    key: 'employer',
    audience: 'EMPLOYER',
    name: 'Employer',
    features: PLAN_FEATURES.employer,
    limits: {
      activePairs: 0,
      adminSeats: 5,
      companies: 1,
      programs: 0,
      // 50 candidate messages per month.
      monthlyBroadcastRecipients: 50,
      aiCallsPerMonth: 0,
    },
    // €99/mo annually (€1 188/yr); no published monthly price.
    prices: { MONTHLY: null, YEARLY: 1_188 },
  },
  {
    key: 'employer_plus',
    audience: 'EMPLOYER',
    name: 'Employer Plus',
    features: PLAN_FEATURES.employer_plus,
    limits: {
      activePairs: 0,
      adminSeats: 20,
      companies: 1,
      programs: 0,
      monthlyBroadcastRecipients: 500,
      aiCallsPerMonth: 0,
    },
    // €299/mo annually (€3 588/yr); no published monthly price.
    prices: { MONTHLY: null, YEARLY: 3_588 },
  },
];

// The free plan of each wallet. Every fallback in this module lands here: an
// unknown plan key, a cancelled subscription, an org with no subscription row
// at all. Failing to the free tier is the only safe direction — failing to
// "unlimited" would hand out the paid product on a typo.
export const FREE_PLAN_KEY: Record<PlanAudience, PlanKey> = {
  PROGRAM: 'community',
  EMPLOYER: 'employer_free',
};

// Legacy `Organization.plan` (the three-value OrgPlan enum) → a plan key here.
// Used by BOTH the deploy backfill (prisma/backfill-org-subscription.mjs, which
// keeps its own copy because it runs as plain node with no TS toolchain — the
// unit test asserts the two agree) and getOrCreateSubscription(), so a tenant
// resolves the same plan whichever path creates its row.
export const LEGACY_PLAN_MAP: Record<'FREE' | 'PRO' | 'ENTERPRISE', PlanKey> = {
  FREE: 'community',
  PRO: 'program',
  ENTERPRISE: 'enterprise',
};

// The published, non-negotiated education / non-profit discount: 50 %.
export const EDUCATION_DISCOUNT_RATE = 0.5;

const BY_KEY = new Map<PlanKey, Plan>(PLANS.map((p) => [p.key, p]));

// ── Type guards ──────────────────────────────────────────────────────────────

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === 'string' && BY_KEY.has(value as PlanKey);
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return typeof value === 'string' && (BILLING_INTERVALS as readonly string[]).includes(value);
}

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

// ── Lookups ──────────────────────────────────────────────────────────────────

// The plan for a key, or null when the key is not one we sell. Callers that
// need a plan no matter what should use planFeatures()/planLimits(), which fall
// back to the free tier instead of returning null.
export function getPlan(key: unknown): Plan | null {
  return isPlanKey(key) ? (BY_KEY.get(key) as Plan) : null;
}

export function plansForAudience(audience: PlanAudience): readonly Plan[] {
  return PLANS.filter((p) => p.audience === audience);
}

// Features included in a plan. An unknown key resolves to the programme-side
// free tier (= no premium features), never to an error and never to everything.
export function planFeatures(key: unknown): readonly PremiumFeature[] {
  return (getPlan(key) ?? (BY_KEY.get(FREE_PLAN_KEY.PROGRAM) as Plan)).features;
}

// Limits of a plan, with the same fallback as planFeatures().
export function planLimits(key: unknown): PlanLimits {
  return (getPlan(key) ?? (BY_KEY.get(FREE_PLAN_KEY.PROGRAM) as Plan)).limits;
}

// Amount charged for one interval, in whole EUR; null when the plan is not sold
// on that interval or the key is unknown.
export function planPrice(key: unknown, interval: BillingInterval): number | null {
  const plan = getPlan(key);
  return plan ? plan.prices[interval] : null;
}

// What a customer actually pays for one interval, in whole EUR: the published
// price with the education/non-profit discount applied when the subscription
// carries it. Rounded to the nearest euro, because that is the granularity
// every published price in this file uses — half-euro line items on an invoice
// are a support ticket, not a feature.
export function effectivePrice(
  key: unknown,
  interval: BillingInterval,
  options: { educationDiscount?: boolean } = {},
): number | null {
  const price = planPrice(key, interval);
  if (price == null) return null;
  if (!options.educationDiscount) return price;
  return Math.round(price * (1 - EDUCATION_DISCOUNT_RATE));
}

// The cheapest plan that includes a feature, in PLANS order (cheapest first
// within each wallet). This is what a refusal names so the caller can render
// "upgrade to X" without hardcoding the packaging a second time. Null when no
// plan sells the feature at all — which for AI_PACKAGE is the correct answer:
// it is an add-on, granted per tenant.
export function planIncludingFeature(feature: PremiumFeature, audience: PlanAudience = 'PROGRAM'): PlanKey | null {
  return PLANS.find((p) => p.audience === audience && p.features.includes(feature))?.key ?? null;
}

// ── Entitlement resolution — the one function ────────────────────────────────
//
// Every entitlement answer in the product comes from here. A feature check
// written inline at a call site ("if plan === 'enterprise'") is how a paywall
// leaks: one of the checks is always forgotten, or disagrees with the pricing
// page, or forgets that a pilot tenant was granted the feature by hand.
//
// The rule has exactly three inputs and no clock:
//   1. the plan's own features — but only while the subscription's STATUS
//      still carries them;
//   2. the per-tenant grants (OrgEntitlement rows), which only ever ADD;
//   3. the free tier, which is where everything unknown lands.

// Which statuses still carry the plan's features:
//   TRIALING  — the trial IS the product; a trial that entitles nothing is a
//               screenshot.
//   ACTIVE    — obviously.
//   PAST_DUE  — a failed card is a dunning problem, not a reason to take a
//               running programme offline mid-cohort. Access continues while
//               we chase the payment; CANCELED is how access actually ends.
// and which do not:
//   CANCELED   — the subscription is over (cancelAtPeriodEnd is a *pending*
//                cancellation and stays ACTIVE until it lands, so this really
//                does mean over).
//   INCOMPLETE — checkout never completed, so nothing was ever paid for.
export const ENTITLING_STATUSES: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

export function statusCarriesPlan(status: unknown): boolean {
  return isSubscriptionStatus(status) && ENTITLING_STATUSES.includes(status);
}

export interface EntitlementInput {
  // `Subscription.planKey`; anything unknown or absent → the free tier.
  planKey?: string | null;
  // `Subscription.status`; anything unknown or absent → not entitling.
  status?: string | null;
  // Features granted outside the plan (`OrgEntitlement.feature`). The caller
  // MUST have dropped expired rows already — this module has no clock.
  grants?: readonly string[] | null;
}

export interface EntitlementResolution {
  // The plan the answer was computed from, normalized (never an unknown key).
  planKey: PlanKey;
  // Whether the subscription's status carries the plan's features at all.
  planActive: boolean;
  // Everything the tenant may use: plan features (when active) + grants.
  features: readonly PremiumFeature[];
  // Where each half came from, so a billing screen can say "included in your
  // plan" vs. "granted to you" instead of guessing.
  fromPlan: readonly PremiumFeature[];
  fromGrant: readonly PremiumFeature[];
  // Limits that apply. A non-entitling status falls back to the free tier of
  // the plan's own wallet — an expired Program Plus tenant is a Community
  // tenant, not an unlimited one.
  limits: PlanLimits;
}

export function resolveEntitlements(input: EntitlementInput): EntitlementResolution {
  const plan = getPlan(input.planKey);
  const audience: PlanAudience = plan?.audience ?? 'PROGRAM';
  const planActive = !!plan && statusCarriesPlan(input.status);

  const fromPlan = planActive ? (plan as Plan).features : [];
  // A grant for a feature the plan already includes is not counted twice, and
  // an unrecognised grant key is ignored rather than trusted: the column is
  // free text, and a typo must never become an entitlement.
  const planned = new Set<string>(fromPlan);
  const fromGrant = dedupeFeatures(input.grants).filter((f) => !planned.has(f));

  const effectiveKey: PlanKey = planActive ? (plan as Plan).key : FREE_PLAN_KEY[audience];

  return {
    planKey: plan?.key ?? FREE_PLAN_KEY[audience],
    planActive,
    features: [...fromPlan, ...fromGrant],
    fromPlan,
    fromGrant,
    limits: planLimits(effectiveKey),
  };
}

// Is one feature available? The single question every gate should ask.
export function isEntitled(input: EntitlementInput, feature: PremiumFeature): boolean {
  return resolveEntitlements(input).features.includes(feature);
}

// Grants are free text in the DB. Keep only keys some plan in this matrix could
// legitimately name, deduplicated, in the order the caller supplied them.
function dedupeFeatures(values: readonly string[] | null | undefined): PremiumFeature[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: PremiumFeature[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || seen.has(value)) continue;
    seen.add(value);
    if (KNOWN_GRANTABLE_FEATURES.has(value)) out.push(value as PremiumFeature);
  }
  return out;
}

// Features sold only as a grant — no plan includes them, so a tenant gets them
// through an OrgEntitlement row: the AI pack is a paid add-on (€49/mo per org)
// and early access is handed out per pilot.
export const GRANT_ONLY_FEATURES: readonly PremiumFeature[] = ['AI_PACKAGE'];

// Every feature key a grant may legitimately name: whatever some plan sells,
// plus the grant-only add-ons. Enumerated from the matrix itself rather than
// imported from PREMIUM_FEATURES, so this file keeps its no-runtime-imports
// promise; the unit test asserts the two sets agree, which is what catches a
// feature added to the catalogue and forgotten here.
export const KNOWN_GRANTABLE_FEATURES: ReadonlySet<string> = new Set<string>([
  ...PLANS.flatMap((p) => [...p.features]),
  ...GRANT_ONLY_FEATURES,
]);

// ── Published commercials beyond the plan table (#1730) ──────────────────────
//
// Everything below is what the pricing page needs and the plan matrix above
// does not carry: how we count, what we never count, what going over the band
// costs, the add-ons, and the per-hire alternative on the employer side. It
// lives here rather than in a module of its own for the reason stated at the
// top of this file — a second home for a published number is how the pricing
// page and the invoice start disagreeing.

// The one metering unit of the programme side. A pair is counted for a
// calendar month when it is an ACTIVE relation with any logged activity in
// that month; paused, benched and completed pairs are not counted. #1750
// computes it — this constant is the name the page and the invoice both use.
export const METERING_UNIT = 'ACTIVE_PAIR_MONTH' as const;

// What is never metered, at any tier, for anybody. Capability KEYS, not prose:
// the pricing page renders each from `pricing.neverMetered.<key>`, so the
// promise and the list it is made of cannot drift apart in one locale.
//
// This list is the free-core rule in machine-readable form. Nothing in it may
// ever appear as a paid line item — not as a plan feature, not as an add-on.
export const NEVER_METERED = [
  'messaging',
  'meetings',
  'video',
  'goals',
  'evaluations',
  'interactionLogs',
  'cv',
  'portal',
  'pipeline',
] as const;
export type NeverMeteredCapability = (typeof NEVER_METERED)[number];

// Going over the band is not a penalty, and the page makes that checkable by
// publishing the RULE instead of a number: one extra pair costs this share of
// what a pair inside the band costs at the annual price, rounded to 10 cents.
// Below 1.0 means over-band pairs are always cheaper than in-band ones, which
// is the promise "aşım cezası değil" actually rests on.
export const OVERAGE_SHARE = 0.8;

/**
 * The overage rate for a plan, in CENTS per extra active pair per month, or
 * null when the plan has no overage to quote.
 *
 * Derived rather than stored, deliberately: a stored rate is a second price,
 * and it goes stale the first time a plan's YEARLY figure moves. The unit test
 * pins Program to the already-published 120 cents, so the rule cannot quietly
 * restate the public figure as something else.
 *
 * Null for: Enterprise (no band — unlimited), Community (a free tier's cap is
 * hard, because billing an overage needs a card and Community has none), and
 * every employer plan (they own no pairs at all).
 *
 * Cents, not euros, because €1.20 is not representable as a whole-EUR price
 * like everything in `Plan.prices`, and a float euro on an invoice line is a
 * rounding bug waiting for a support ticket.
 */
export function overagePerPairCents(key: unknown): number | null {
  const plan = getPlan(key);
  if (!plan) return null;
  const band = plan.limits.activePairs;
  const yearly = plan.prices.YEARLY;
  if (band == null || band <= 0 || yearly == null || yearly <= 0) return null;
  const perPairPerMonth = yearly / 12 / band;
  return Math.round((perPairPerMonth * OVERAGE_SHARE * 100) / 10) * 10;
}

/**
 * What paying annually saves, in whole EUR per year, or null when the plan is
 * not sold on both intervals (Enterprise is annual-only) or is free.
 *
 * Derived, and the page prints the derived figure rather than a rounded claim.
 * A fixed "2 months free" was exactly true for Program Plus (479 × 10 ≈ 4 788)
 * and understated Program, whose annual price is nearer two and a half months
 * off — so the headline discount contradicted the very table under it.
 */
export function annualSavingEur(key: unknown): number | null {
  const plan = getPlan(key);
  if (!plan) return null;
  const { MONTHLY, YEARLY } = plan.prices;
  if (MONTHLY == null || YEARLY == null || MONTHLY <= 0) return null;
  const saving = MONTHLY * 12 - YEARLY;
  return saving > 0 ? saving : null;
}

/**
 * The monthly-equivalent price of the annual plan, in whole EUR — the headline
 * figure on a pricing column ("€149/month, billed annually"), which is the
 * annual total divided by twelve rather than a second published number.
 *
 * Every plan sold annually divides evenly today (1 788, 4 788, 8 988, 1 188 and
 * 3 588 are all multiples of 12), so the rounding never actually bites; it is
 * there because the next price someone picks might not be, and a column
 * reading "€149.0833/month" is worse than one cent of imprecision.
 */
export function annualMonthlyEur(key: unknown): number | null {
  const yearly = getPlan(key)?.prices.YEARLY;
  return yearly == null ? null : Math.round(yearly / 12);
}

/**
 * The same saving expressed in months of the monthly price, to one decimal —
 * "2.5 months free" lands with a buyer in a way "€480" does not. Null exactly
 * when annualSavingEur() is.
 */
export function annualMonthsFree(key: unknown): number | null {
  const saving = annualSavingEur(key);
  const monthly = getPlan(key)?.prices.MONTHLY;
  if (saving == null || monthly == null || monthly <= 0) return null;
  return Math.round((saving / monthly) * 10) / 10;
}

// ── Add-ons ──────────────────────────────────────────────────────────────────

export const ADDON_KEYS = ['ai_pack', 'migration', 'eu_hosting', 'extra_languages'] as const;
export type AddonKey = (typeof ADDON_KEYS)[number];

// PER_MONTH and ONE_OFF are charged; INCLUDED is a published promise that
// something costs nothing. `extra_languages` is INCLUDED rather than absent
// from this list on purpose: "additional languages are free" is a competitive
// claim, and a claim nobody can find is not made.
export type AddonBilling = 'PER_MONTH' | 'ONE_OFF' | 'INCLUDED';

export interface Addon {
  key: AddonKey;
  // Whole EUR, net of VAT, per `billing`.
  priceEur: number;
  billing: AddonBilling;
  // The premium feature this add-on grants, when it maps to one. The AI pack
  // is the only one that does — it is the whole of GRANT_ONLY_FEATURES — and
  // naming it here is what keeps its published price and its entitlement key
  // from being maintained in two places.
  grants?: PremiumFeature;
}

export const ADDONS: readonly Addon[] = [
  { key: 'ai_pack', priceEur: 49, billing: 'PER_MONTH', grants: 'AI_PACKAGE' },
  { key: 'migration', priceEur: 890, billing: 'ONE_OFF' },
  { key: 'eu_hosting', priceEur: 99, billing: 'PER_MONTH' },
  { key: 'extra_languages', priceEur: 0, billing: 'INCLUDED' },
];

// ── The per-hire alternative, and why it is not for sale yet ─────────────────
//
// €890 per confirmed hire, offered instead of an employer subscription to a
// company that hires rarely.
//
// NOT BOOKABLE. Charging a fee for placing a person touches regulated ground
// in both of our markets — Arbeitsvermittlung / AÜG in Germany and the İŞKUR
// private-employment-agency regime in Turkey — and neither has been checked by
// a lawyer. So the pricing page renders the figure with a "subject to a legal
// check before it can be booked" footnote and gives it no CTA, which is the
// difference between publishing a price and selling a service.
//
// `PLACEMENT_FEE_BOOKABLE` flips in the same diff as the legal sign-off and
// not one commit earlier; the page reads the flag rather than hardcoding the
// footnote, so the footnote disappears by itself when it stops being true.
export const PLACEMENT_FEE_EUR = 890;
export const PLACEMENT_FEE_BOOKABLE = false;

// ── Where the price is actually agreed, today ────────────────────────────────
//
// There is no self-serve checkout: `Subscription.currentPeriodStart` is
// nullable precisely because "the authority for these dates is the billing
// provider, which is not wired up yet". Every paid plan is therefore invoiced
// by hand after a conversation.
//
// The pricing page has to say so. A published price list with a "Buy" button
// that opens an email client is worse than one that tells you up front how
// this works — and the honest version is also the one that does not promise a
// card flow we would then have to build in a hurry.
export const SELF_SERVE_CHECKOUT = false;
