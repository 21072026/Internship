// Unit tests for the plan → feature matrix (#1731, epic #1727).
//
// Run: npm run test:plans  (node --test --experimental-strip-types)
//
// src/lib/plans.ts decides who may use what and what they pay for it, and every
// way of getting it wrong typechecks perfectly:
//   • an unknown plan key resolving to "everything" instead of the free tier
//     gives the paid product away on a typo;
//   • a cancelled subscription that keeps its plan's limits is a customer who
//     stopped paying and noticed nothing;
//   • a hand-granted pilot feature that the resolver drops is a customer who
//     paid and lost access;
//   • the 50 % education discount applied to a price that is not sold on that
//     interval invents a number nobody published;
//   • and the legacy FREE/PRO/ENTERPRISE translation exists TWICE — here in
//     TypeScript and again in prisma/backfill-org-subscription.mjs, which runs
//     as plain node inside the deployed image. Those two disagreeing puts a
//     tenant on the wrong plan on the deploy that creates its row.
// None of that is reachable from a browser test, so it is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BILLING_INTERVALS,
  EDUCATION_DISCOUNT_RATE,
  ENTITLING_STATUSES,
  FREE_PLAN_KEY,
  GRANT_ONLY_FEATURES,
  KNOWN_GRANTABLE_FEATURES,
  LEGACY_PLAN_MAP,
  PLANS,
  PLAN_KEYS,
  SUBSCRIPTION_STATUSES,
  effectivePrice,
  getPlan,
  isEntitled,
  isPlanKey,
  planFeatures,
  planIncludingFeature,
  planLimits,
  ADDONS,
  ADDON_KEYS,
  METERING_UNIT,
  NEVER_METERED,
  PLACEMENT_FEE_BOOKABLE,
  PLACEMENT_FEE_EUR,
  SELF_SERVE_CHECKOUT,
  annualMonthlyEur,
  annualMonthsFree,
  annualSavingEur,
  overagePerPairCents,
  planPrice,
  plansForAudience,
  resolveEntitlements,
  statusCarriesPlan,
} from '../../src/lib/plans.ts';
import { PREMIUM_FEATURES } from '../../src/lib/entitlementsCatalog.ts';
import { LEGACY_PLAN_MAP as BACKFILL_LEGACY_PLAN_MAP } from '../../prisma/backfill-org-subscription.mjs';

const LIMIT_KEYS = [
  'activePairs',
  'adminSeats',
  'companies',
  'programs',
  'monthlyBroadcastRecipients',
  'aiCallsPerMonth',
];

// ── The matrix itself ────────────────────────────────────────────────────────

test('every declared plan key has exactly one plan, and vice versa', () => {
  assert.deepEqual(
    PLANS.map((p) => p.key),
    [...PLAN_KEYS],
  );
  assert.equal(new Set(PLANS.map((p) => p.key)).size, PLANS.length);
});

test('every plan declares every limit, and only sane values', () => {
  for (const plan of PLANS) {
    for (const key of LIMIT_KEYS) {
      const value = plan.limits[key];
      assert.ok(
        value === null || (Number.isInteger(value) && value >= 0),
        `${plan.key}.${key} must be null (unlimited) or a non-negative integer, got ${String(value)}`,
      );
    }
    for (const interval of BILLING_INTERVALS) {
      const price = plan.prices[interval];
      assert.ok(
        price === null || (Number.isInteger(price) && price >= 0),
        `${plan.key} price for ${interval} must be null or a non-negative integer, got ${String(price)}`,
      );
    }
  }
});

test('every feature a plan sells is a real catalogue key', () => {
  const catalogue = new Set(PREMIUM_FEATURES.map((f) => f.key));
  for (const plan of PLANS) {
    for (const feature of plan.features) {
      assert.ok(catalogue.has(feature), `${plan.key} sells unknown feature ${feature}`);
    }
  }
});

// The grantable set is enumerated from the matrix instead of imported from the
// catalogue, so plans.ts can stay free of runtime imports (it is imported by
// client components). This is the assertion that keeps that trick honest: a
// feature added to PREMIUM_FEATURES and to no plan would otherwise be silently
// unGRANTable — an admin could create the OrgEntitlement row and the resolver
// would drop it as a typo.
test('every catalogue feature can be granted', () => {
  for (const { key } of PREMIUM_FEATURES) {
    assert.ok(KNOWN_GRANTABLE_FEATURES.has(key), `${key} is in the catalogue but no plan or add-on can grant it`);
  }
});

test('a grant-only feature is sold by no plan', () => {
  for (const feature of GRANT_ONLY_FEATURES) {
    assert.equal(
      planIncludingFeature(feature),
      null,
      `${feature} is an add-on — including it in a plan gives it away`,
    );
    assert.equal(planIncludingFeature(feature, 'EMPLOYER'), null);
  }
});

test('the free tier of each audience sells nothing premium', () => {
  for (const [audience, key] of Object.entries(FREE_PLAN_KEY)) {
    const plan = getPlan(key);
    assert.ok(plan, `${audience} free plan ${key} does not exist`);
    assert.equal(plan.audience, audience);
    assert.deepEqual([...plan.features], []);
  }
});

test('a paid plan never sells less than the cheaper plan of the same audience', () => {
  for (const audience of ['PROGRAM', 'EMPLOYER']) {
    const ladder = plansForAudience(audience);
    for (let i = 1; i < ladder.length; i++) {
      for (const feature of ladder[i - 1].features) {
        assert.ok(
          ladder[i].features.includes(feature),
          `${ladder[i].key} drops ${feature}, which the cheaper ${ladder[i - 1].key} includes`,
        );
      }
    }
  }
});

test('the cheapest plan including a feature is named, per audience', () => {
  assert.equal(planIncludingFeature('ADVANCED_ANALYTICS'), 'program');
  assert.equal(planIncludingFeature('WHITE_LABEL'), 'program_plus');
  assert.equal(planIncludingFeature('SSO_SAML'), 'program_plus');
  // A programme-side answer must never point a university at an employer plan.
  assert.equal(planIncludingFeature('TALENT_POOL_SEARCH'), null);
  assert.equal(planIncludingFeature('TALENT_POOL_SEARCH', 'EMPLOYER'), 'employer');
});

// ── Fallbacks: unknown input must land on the free tier, never on everything ─

test('an unknown plan key resolves to the free tier, not to unlimited', () => {
  for (const bad of ['', 'ENTERPRISE', 'program-plus', 'pro', null, undefined, 42, {}]) {
    assert.equal(isPlanKey(bad), false, `${String(bad)} must not be a plan key`);
    assert.equal(getPlan(bad), null);
    assert.deepEqual([...planFeatures(bad)], []);
    assert.deepEqual(planLimits(bad), planLimits(FREE_PLAN_KEY.PROGRAM));
    assert.equal(planPrice(bad, 'YEARLY'), null);
  }
});

test('a plan not sold on an interval has no price on it', () => {
  assert.equal(planPrice('enterprise', 'MONTHLY'), null);
  assert.equal(planPrice('enterprise', 'YEARLY'), 8_988);
  assert.equal(effectivePrice('enterprise', 'MONTHLY', { educationDiscount: true }), null);
});

// ── The education discount ───────────────────────────────────────────────────

test('the education discount halves the published price and nothing else', () => {
  assert.equal(EDUCATION_DISCOUNT_RATE, 0.5);
  assert.equal(effectivePrice('program', 'YEARLY'), 1_788);
  assert.equal(effectivePrice('program', 'YEARLY', { educationDiscount: false }), 1_788);
  assert.equal(effectivePrice('program', 'YEARLY', { educationDiscount: true }), 894);
  // Rounded to whole euros: 189 / 2 = 94.5 → 95, never 94.5 on an invoice.
  assert.equal(effectivePrice('program', 'MONTHLY', { educationDiscount: true }), 95);
  assert.equal(effectivePrice('enterprise', 'YEARLY', { educationDiscount: true }), 4_494);
  // Free stays free, and the discount cannot make a price negative.
  assert.equal(effectivePrice('community', 'MONTHLY', { educationDiscount: true }), 0);
  for (const plan of PLANS) {
    for (const interval of BILLING_INTERVALS) {
      const price = effectivePrice(plan.key, interval, { educationDiscount: true });
      assert.ok(price === null || price >= 0, `${plan.key}/${interval} discounted to ${String(price)}`);
    }
  }
});

// ── Status → does the plan still apply? ──────────────────────────────────────

test('trialing, active and past-due carry the plan; cancelled and incomplete do not', () => {
  assert.deepEqual([...ENTITLING_STATUSES], ['TRIALING', 'ACTIVE', 'PAST_DUE']);
  for (const status of ['TRIALING', 'ACTIVE', 'PAST_DUE']) {
    assert.equal(statusCarriesPlan(status), true, `${status} must carry the plan`);
  }
  for (const status of ['CANCELED', 'INCOMPLETE']) {
    assert.equal(statusCarriesPlan(status), false, `${status} must not carry the plan`);
  }
  // Every declared status is decided one way or the other, and nothing else is.
  for (const status of SUBSCRIPTION_STATUSES) {
    assert.equal(typeof statusCarriesPlan(status), 'boolean');
  }
  for (const junk of ['active', 'ACTIVE ', '', null, undefined, 1]) {
    assert.equal(statusCarriesPlan(junk), false, `${String(junk)} must not carry the plan`);
  }
});

// ── resolveEntitlements: the one function every caller goes through ──────────

test('an active plan grants exactly its own features', () => {
  const r = resolveEntitlements({ planKey: 'program_plus', status: 'ACTIVE' });
  assert.equal(r.planKey, 'program_plus');
  assert.equal(r.planActive, true);
  assert.deepEqual([...r.features], ['ADVANCED_ANALYTICS', 'REPORT_EXPORT', 'WHITE_LABEL', 'SSO_SAML']);
  assert.deepEqual([...r.fromGrant], []);
  assert.deepEqual(r.limits, planLimits('program_plus'));
  assert.equal(isEntitled({ planKey: 'program_plus', status: 'ACTIVE' }, 'WHITE_LABEL'), true);
  assert.equal(isEntitled({ planKey: 'program', status: 'ACTIVE' }, 'WHITE_LABEL'), false);
});

test('a trialing tenant gets the full plan — a trial that entitles nothing is a screenshot', () => {
  const trial = resolveEntitlements({ planKey: 'program', status: 'TRIALING' });
  assert.equal(trial.planActive, true);
  assert.deepEqual([...trial.features], [...planFeatures('program')]);
  assert.deepEqual(trial.limits, planLimits('program'));
});

test('past due keeps access; cancelled falls back to the free tier of its own audience', () => {
  const pastDue = resolveEntitlements({ planKey: 'program_plus', status: 'PAST_DUE' });
  assert.equal(pastDue.planActive, true);
  assert.deepEqual([...pastDue.features], [...planFeatures('program_plus')]);

  for (const status of ['CANCELED', 'INCOMPLETE']) {
    const dead = resolveEntitlements({ planKey: 'program_plus', status });
    assert.equal(dead.planActive, false);
    assert.deepEqual([...dead.features], []);
    // Not unlimited: an expired Program Plus tenant is a Community tenant.
    assert.deepEqual(dead.limits, planLimits('community'));
    assert.equal(dead.limits.activePairs, 25);
  }

  const deadEmployer = resolveEntitlements({ planKey: 'employer_plus', status: 'CANCELED' });
  assert.deepEqual(deadEmployer.limits, planLimits('employer_free'));
});

test('an empty input is the free tier, not an error and not everything', () => {
  const r = resolveEntitlements({});
  assert.equal(r.planKey, FREE_PLAN_KEY.PROGRAM);
  assert.equal(r.planActive, false);
  assert.deepEqual([...r.features], []);
  assert.deepEqual(r.limits, planLimits('community'));
});

test('a grant adds a feature the plan does not sell, even on the free tier', () => {
  const r = resolveEntitlements({ planKey: 'community', status: 'ACTIVE', grants: ['WHITE_LABEL'] });
  assert.deepEqual([...r.features], ['WHITE_LABEL']);
  assert.deepEqual([...r.fromPlan], []);
  assert.deepEqual([...r.fromGrant], ['WHITE_LABEL']);
  // A grant never buys the plan's LIMITS — only the feature.
  assert.deepEqual(r.limits, planLimits('community'));
});

test('a grant survives a cancelled subscription — it was granted, not sold', () => {
  const r = resolveEntitlements({ planKey: 'program_plus', status: 'CANCELED', grants: ['AI_PACKAGE'] });
  assert.equal(r.planActive, false);
  assert.deepEqual([...r.features], ['AI_PACKAGE']);
  assert.equal(isEntitled({ planKey: 'program_plus', status: 'CANCELED', grants: ['AI_PACKAGE'] }, 'WHITE_LABEL'), false);
});

test('a grant is never counted twice and a typo is never an entitlement', () => {
  const r = resolveEntitlements({
    planKey: 'program',
    status: 'ACTIVE',
    grants: ['ADVANCED_ANALYTICS', 'WHITE_LABEL', 'WHITE_LABEL', 'white_label', 'NOT_A_FEATURE', ''],
  });
  assert.deepEqual([...r.features], ['ADVANCED_ANALYTICS', 'REPORT_EXPORT', 'WHITE_LABEL']);
  assert.deepEqual([...r.fromGrant], ['WHITE_LABEL']);
});

test('resolveEntitlements never mutates the matrix it read from', () => {
  const before = JSON.stringify(PLANS);
  resolveEntitlements({ planKey: 'program', status: 'ACTIVE', grants: ['WHITE_LABEL', 'AI_PACKAGE'] });
  assert.equal(JSON.stringify(PLANS), before);
});

// ── The legacy translation exists twice; the copies must agree ───────────────

test('LEGACY_PLAN_MAP maps the three legacy tiers onto real plans', () => {
  assert.deepEqual(LEGACY_PLAN_MAP, { FREE: 'community', PRO: 'program', ENTERPRISE: 'enterprise' });
  for (const key of Object.values(LEGACY_PLAN_MAP)) {
    assert.ok(isPlanKey(key), `${key} is not a plan key`);
  }
  // FREE must land on the free tier: it is also the fallback both the backfill
  // and getOrCreateSubscription() use for an unreadable legacy plan.
  assert.equal(LEGACY_PLAN_MAP.FREE, FREE_PLAN_KEY.PROGRAM);
});

test('the deploy backfill translates legacy plans exactly like the matrix does', () => {
  assert.deepEqual(BACKFILL_LEGACY_PLAN_MAP, LEGACY_PLAN_MAP);
});

// ── The published commercials (#1730) ────────────────────────────────────────
//
// The pricing page prints these, so getting one wrong is a wrong number on a
// public page — and two of them are DERIVED from the plan table rather than
// stored, which is the whole point but also means a price change silently
// moves them. These tests are what makes that movement loud.

test('NEVER_METERED is the free-core rule and holds no billable capability', () => {
  // The promise is structural: nothing on this list may be sold, so no entry
  // may collide with a premium feature key or an add-on key.
  assert.ok(NEVER_METERED.length > 0);
  assert.equal(new Set(NEVER_METERED).size, NEVER_METERED.length, 'duplicate entry');
  for (const cap of NEVER_METERED) {
    assert.ok(!KNOWN_GRANTABLE_FEATURES.has(cap), `${cap} is sold as a premium feature`);
    assert.ok(!ADDON_KEYS.includes(cap), `${cap} is sold as an add-on`);
  }
  // The pipeline and the mentee portal are the two the free-core claim is
  // most often read as excluding. Pin them by name.
  assert.ok(NEVER_METERED.includes('pipeline'));
  assert.ok(NEVER_METERED.includes('portal'));
});

test('the overage rate is the published 120 cents for Program', () => {
  // €1.20/pair/month is already public. The rule (80 % of the in-band annual
  // per-pair price) has to reproduce it exactly, or the rule is not the rule.
  assert.equal(overagePerPairCents('program'), 120);
});

test('an over-band pair is always cheaper than an in-band one', () => {
  // This is the "going over is not a penalty" promise, checked rather than
  // asserted in prose. Every plan that quotes an overage must satisfy it.
  for (const plan of PLANS) {
    const cents = overagePerPairCents(plan.key);
    if (cents == null) continue;
    const inBandCents = ((plan.prices.YEARLY / 12) * 100) / plan.limits.activePairs;
    assert.ok(
      cents < inBandCents,
      `${plan.key}: overage ${cents}c is not below the in-band ${inBandCents.toFixed(1)}c`,
    );
  }
});

test('overage is quoted only where a band can actually be exceeded', () => {
  // Program Plus has a band and a price, so it gets a rate too — a banded paid
  // plan with no overage rate can only mean "upgrade or stop", which is not
  // what the page says.
  assert.equal(overagePerPairCents('program_plus'), 80);
  // Unlimited: nothing to exceed.
  assert.equal(overagePerPairCents('enterprise'), null);
  // Free tier: billing an overage needs a card, and Community has none, so its
  // cap is hard.
  assert.equal(overagePerPairCents('community'), null);
  // The employer wallet owns no pairs at all.
  for (const key of ['employer_free', 'employer', 'employer_plus']) {
    assert.equal(overagePerPairCents(key), null, key);
  }
  // An unknown key must not fall back to some plan's rate.
  assert.equal(overagePerPairCents('nope'), null);
  assert.equal(overagePerPairCents(undefined), null);
});

test('the annual saving is derived from the two published prices', () => {
  // Program: €189 × 12 = €2 268 monthly vs €1 788 annually.
  assert.equal(annualSavingEur('program'), 480);
  // Program Plus: €479 × 12 = €5 748 vs €4 788.
  assert.equal(annualSavingEur('program_plus'), 960);
  // Annual-only and free plans have no saving to state.
  assert.equal(annualSavingEur('enterprise'), null);
  assert.equal(annualSavingEur('community'), null);
  assert.equal(annualSavingEur('employer'), null);
  assert.equal(annualSavingEur('nope'), null);
});

test('the saving in months is what the page prints, not a rounded claim', () => {
  // The reason a fixed "2 months free" was dropped: it is true for Program
  // Plus and understates Program by half a month.
  assert.equal(annualMonthsFree('program'), 2.5);
  assert.equal(annualMonthsFree('program_plus'), 2);
  assert.equal(annualMonthsFree('enterprise'), null);
  assert.equal(annualMonthsFree('community'), null);
  assert.equal(annualMonthsFree('nope'), null);
});

test('every add-on has a price, a billing shape and at most one grant', () => {
  assert.deepEqual(
    ADDONS.map((a) => a.key),
    [...ADDON_KEYS],
    'ADDONS and ADDON_KEYS disagree',
  );
  for (const addon of ADDONS) {
    assert.ok(Number.isInteger(addon.priceEur) && addon.priceEur >= 0, addon.key);
    assert.ok(['PER_MONTH', 'ONE_OFF', 'INCLUDED'].includes(addon.billing), addon.key);
    // A charged add-on with a zero price is a giveaway nobody decided on; an
    // INCLUDED one with a price is a charge nobody sees.
    if (addon.billing === 'INCLUDED') assert.equal(addon.priceEur, 0, addon.key);
    else assert.ok(addon.priceEur > 0, addon.key);
    if (addon.grants) assert.ok(KNOWN_GRANTABLE_FEATURES.has(addon.grants), addon.key);
  }
  // The AI pack is the add-on that must stay an add-on: folding it into a tier
  // gives away a €49/mo product.
  const ai = ADDONS.find((a) => a.key === 'ai_pack');
  assert.equal(ai.priceEur, 49);
  assert.equal(ai.grants, 'AI_PACKAGE');
  assert.ok(GRANT_ONLY_FEATURES.includes('AI_PACKAGE'));
  // "Additional languages cost nothing" is a claim we publish, so it has to be
  // in the list a reader can find.
  assert.equal(ADDONS.find((a) => a.key === 'extra_languages').billing, 'INCLUDED');
});

test('the placement fee is published but not bookable until a lawyer says so', () => {
  assert.equal(PLACEMENT_FEE_EUR, 890);
  // Flipping this without a legal sign-off is the failure mode; the test is
  // here so the flip cannot happen as a silent one-character diff.
  assert.equal(PLACEMENT_FEE_BOOKABLE, false);
});

test('no plan sells a never-metered capability as a feature', () => {
  // Belt and braces over the NEVER_METERED test above: the collision that
  // matters is a capability appearing in some plan's feature list.
  for (const plan of PLANS) {
    for (const feature of plan.features) {
      assert.ok(!NEVER_METERED.includes(feature), `${plan.key} sells ${feature}`);
    }
  }
});

test('there is no self-serve checkout, and the page is told so', () => {
  // Subscription.currentPeriodStart is nullable because no billing provider is
  // wired up. The page reads this flag instead of promising a card flow.
  assert.equal(SELF_SERVE_CHECKOUT, false);
  assert.equal(METERING_UNIT, 'ACTIVE_PAIR_MONTH');
});

test('the annual monthly-equivalent is the yearly total over twelve', () => {
  // The headline figure on a plan column. These are the numbers printed on the
  // website, so they are pinned rather than merely derived.
  assert.equal(annualMonthlyEur('program'), 149);
  assert.equal(annualMonthlyEur('program_plus'), 399);
  assert.equal(annualMonthlyEur('enterprise'), 749);
  assert.equal(annualMonthlyEur('employer'), 99);
  assert.equal(annualMonthlyEur('employer_plus'), 299);
  assert.equal(annualMonthlyEur('community'), 0);
  assert.equal(annualMonthlyEur('nope'), null);
  // Every annually-sold plan divides evenly, so no column shows a rounded
  // price today. If a future price breaks this, the column is still correct to
  // the euro — but we want to know.
  for (const plan of PLANS) {
    if (plan.prices.YEARLY == null) continue;
    assert.equal(plan.prices.YEARLY % 12, 0, `${plan.key} does not divide evenly`);
  }
});
