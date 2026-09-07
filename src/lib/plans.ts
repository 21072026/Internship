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
