// Unit tests for a partner's funnel and threshold progress (src/lib/affiliateFunnelRule.ts,
// docs/affiliate-module.md "The funnel", #3543). Synthetic numbers and dates only.
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// affiliateFunnelRule.ts imports its sibling without an extension; see ts-extensionless-resolve.mjs.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { periodStart, parseFunnelPeriod, funnelFromCounts, stepRate, thresholdProgress } = await import('../../src/lib/affiliateFunnelRule.ts');

const at = (iso) => new Date(iso);

test('periodStart: this month, the last 12 calendar months, all', () => {
  const now = at('2026-03-15T10:00:00Z');
  assert.equal(periodStart('month', now).toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(periodStart('year', now).toISOString(), '2025-04-01T00:00:00.000Z');
  assert.equal(periodStart('all', now), null);
  // The first instant of a month is in that month.
  assert.equal(periodStart('month', at('2026-01-01T00:00:00Z')).toISOString(), '2026-01-01T00:00:00.000Z');
});

test('parseFunnelPeriod falls back to this month', () => {
  assert.equal(parseFunnelPeriod('year'), 'year');
  assert.equal(parseFunnelPeriod('all'), 'all');
  assert.equal(parseFunnelPeriod(undefined), 'month');
  assert.equal(parseFunnelPeriod('week'), 'month');
});

test('funnelFromCounts: the story example 50 → 15 → 10 → 7 / 3', () => {
  const f = funnelFromCounts({ clicks: 50, uniqueClicks: 40 }, { FREE_PERIOD: 3, NEVER_PAID: 2, ACTIVE: 7, PASSIVE: 3 });
  assert.deepEqual(f, { clicks: 50, uniqueClicks: 40, registrations: 15, freePeriod: 3, neverPaid: 2, paying: 10, active: 7, passive: 3 });
});

test('stepRate: whole percent, null without a step before, may exceed 100', () => {
  assert.equal(stepRate(50, 15), 30);
  assert.equal(stepRate(3, 2), 67);
  assert.equal(stepRate(0, 4), null);
  assert.equal(stepRate(2, 5), 250);
});

test('thresholdProgress: hidden without a threshold or a percent', () => {
  assert.equal(thresholdProgress(null, 3, null), null);
  assert.equal(thresholdProgress({ switchAtCustomer: null, percentBps: 2000 }, 3, null), null);
  assert.equal(thresholdProgress({ switchAtCustomer: 10, percentBps: 0 }, 3, null), null);
});

test('thresholdProgress: counts what is left, zero once the switch happened', () => {
  const plan = { switchAtCustomer: 10, percentBps: 2000 };
  assert.deepEqual(thresholdProgress(plan, 7, null), { target: 10, paying: 7, left: 3, bps: 2000, reachedAt: null });
  const reached = at('2026-02-01T00:00:00Z');
  assert.deepEqual(thresholdProgress(plan, 12, reached), { target: 10, paying: 12, left: 0, bps: 2000, reachedAt: reached });
});
