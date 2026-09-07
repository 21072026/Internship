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
