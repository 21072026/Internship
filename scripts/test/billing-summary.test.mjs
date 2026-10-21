// Unit tests for the tenant billing summary (#1739).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// The route reads rows; this module puts them next to the published prices.
// What is pinned here is what a screenshot cannot show: a month the nightly
// rollup has not written is "not counted" (null), never 0; the over-band cost
// uses the published overage rule and nothing else; the education discount
// halves the plan price; an unknown plan key falls back to the free tier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { buildBillingSummary, trailingPeriods, pairsOverBand, BILLING_HISTORY_MONTHS } = await import(
  '../../src/lib/billingSummary.ts'
);
const { overagePerPairCents, planLimits } = await import('../../src/lib/plans.ts');

const sub = (over = {}) => ({
  planKey: 'program',
  status: 'ACTIVE',
  interval: 'MONTHLY',
  educationDiscount: false,
  cancelAtPeriodEnd: false,
  currentPeriodEnd: null,
  trialEndsAt: null,
  ...over,
});
const row = (metric, period, value) => ({ metric, period, value, computedAt: '2026-10-20T02:40:00.000Z' });

test('twelve periods, newest first, across a year boundary', () => {
  const p = trailingPeriods('2026-03');
  assert.equal(p.length, BILLING_HISTORY_MONTHS);
  assert.equal(p[0], '2026-03');
  assert.equal(p[2], '2026-01');
  assert.equal(p[3], '2025-12');
  assert.equal(p[11], '2025-04');
});

test('a month without a rollup row reads null, never 0', () => {
  const s = buildBillingSummary({ subscription: sub(), rollups: [], period: '2026-10' });
  assert.equal(s.currentPeriod.activePairs, null);
  assert.equal(s.currentPeriod.computedAt, null);
  assert.equal(s.currentPeriod.overBand, 0);
  assert.equal(s.history.length, 12);
  assert.ok(s.history.every((m) => m.activePairs === null && m.adminSeats === null));
});

test('the current month is the rollup value and carries its computedAt', () => {
  const s = buildBillingSummary({
    subscription: sub(),
    rollups: [row('ACTIVE_MATCHED_PAIRS', '2026-10', 42), row('ADMIN_SEATS', '2026-10', 3), row('ACTIVE_MATCHED_PAIRS', '2026-09', 40)],
    period: '2026-10',
  });
  assert.equal(s.currentPeriod.activePairs, 42);
  assert.equal(s.currentPeriod.adminSeats, 3);
  assert.equal(s.currentPeriod.computedAt, '2026-10-20T02:40:00.000Z');
  assert.equal(s.history[1].period, '2026-09');
  assert.equal(s.history[1].activePairs, 40);
  assert.equal(s.history[1].adminSeats, null);
});

test('rows of other metrics or periods outside the window are ignored', () => {
  const s = buildBillingSummary({
    subscription: sub(),
    rollups: [row('VIDEO_ROOM', '2026-10', 999), row('ACTIVE_MATCHED_PAIRS', '2024-01', 7)],
    period: '2026-10',
  });
  assert.equal(s.currentPeriod.activePairs, null);
  assert.ok(!s.history.some((m) => m.period === '2024-01'));
});

test('over the band: the overage is the published per-pair rate times the pairs over', () => {
  const band = planLimits('program').activePairs;
  const s = buildBillingSummary({ subscription: sub(), rollups: [row('ACTIVE_MATCHED_PAIRS', '2026-10', band + 7)], period: '2026-10' });
  assert.equal(s.band, band);
  assert.equal(s.currentPeriod.overBand, 7);
  assert.equal(s.currentPeriod.overageCents, 7 * overagePerPairCents('program'));
  assert.equal(s.pricing.overagePerPairCents, overagePerPairCents('program'));
});

test('within the band there is nothing over and no cost', () => {
  const s = buildBillingSummary({ subscription: sub(), rollups: [row('ACTIVE_MATCHED_PAIRS', '2026-10', 3)], period: '2026-10' });
  assert.equal(s.currentPeriod.overBand, 0);
  assert.equal(s.currentPeriod.overageCents, 0);
});

test('Community has a hard cap: pairs over it are reported, but no overage is quoted', () => {
  const s = buildBillingSummary({ subscription: sub({ planKey: 'community' }), rollups: [row('ACTIVE_MATCHED_PAIRS', '2026-10', 30)], period: '2026-10' });
  assert.equal(s.currentPeriod.overBand, 30 - planLimits('community').activePairs);
  assert.equal(s.currentPeriod.overageCents, null);
});

test('Enterprise has no band: never over it', () => {
  assert.equal(pairsOverBand(10_000, null), 0);
  const s = buildBillingSummary({ subscription: sub({ planKey: 'enterprise', interval: 'YEARLY' }), rollups: [row('ACTIVE_MATCHED_PAIRS', '2026-10', 10_000)], period: '2026-10' });
  assert.equal(s.band, null);
  assert.equal(s.currentPeriod.overBand, 0);
  assert.equal(s.pricing.monthlyEur, null);
});

test('the education discount halves the plan price, not the overage rate', () => {
  const full = buildBillingSummary({ subscription: sub(), rollups: [], period: '2026-10' });
  const edu = buildBillingSummary({ subscription: sub({ educationDiscount: true }), rollups: [], period: '2026-10' });
  assert.equal(edu.pricing.monthlyEur, Math.round(full.pricing.monthlyEur / 2));
  assert.equal(edu.pricing.annualTotalEur, Math.round(full.pricing.annualTotalEur / 2));
  assert.equal(edu.pricing.overagePerPairCents, full.pricing.overagePerPairCents);
  assert.equal(edu.educationDiscount, true);
});

test('an unknown plan key resolves to the free tier and says it is not published', () => {
  const s = buildBillingSummary({ subscription: sub({ planKey: 'gold' }), rollups: [], period: '2026-10' });
  assert.equal(s.plan.key, 'community');
  assert.equal(s.plan.published, false);
  assert.equal(s.band, planLimits('community').activePairs);
});

test('a cancelled subscription does not carry its plan', () => {
  const s = buildBillingSummary({ subscription: sub({ status: 'CANCELED' }), rollups: [], period: '2026-10' });
  assert.equal(s.statusCarriesPlan, false);
});
