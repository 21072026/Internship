// Unit tests for src/lib/usageRule.ts — the account usage chart (#2448) and
// the usage signals on the attention queue (#2449).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const {
  DAY_MS,
  USAGE_SIGNAL_DEFAULTS,
  dropWindows,
  trialInactive,
  usageDropVerdict,
  usageSeries,
  usageSignalSettings,
  usageSummary,
} = await import('../../src/lib/usageRule.ts');

const day = (s) => new Date(`${s}T00:00:00Z`);
const NOW = new Date('2026-10-07T10:00:00Z');

test('series: a row of 0 is zero, a missing row is no data', () => {
  const s = usageSeries([{ date: day('2026-10-05'), transactions: 0 }, { date: day('2026-10-07'), transactions: 12 }], NOW, 3);
  assert.deepEqual(s, [
    { day: '2026-10-05', value: 0 },
    { day: '2026-10-06', value: null },
    { day: '2026-10-07', value: 12 },
  ]);
  assert.equal(usageSeries([], NOW).length, 90);
});

test('summary counts only days with data; empty windows are null, not 0', () => {
  const rows = [
    { date: day('2026-10-07'), transactions: 5 },
    { date: day('2026-09-20'), transactions: 0 },
    { date: day('2026-08-20'), transactions: 7 },
  ];
  const s = usageSummary(usageSeries(rows, NOW, 90));
  assert.deepEqual(s, { daysWithData: 3, total: 12, max: 7, last30: 5, prev30: 7 });
  const empty = usageSummary(usageSeries([], NOW, 90));
  assert.equal(empty.last30, null);
  assert.equal(empty.prev30, null);
  assert.equal(empty.daysWithData, 0);
});

test('settings parse with a per-field fallback', () => {
  assert.deepEqual(usageSignalSettings({}), USAGE_SIGNAL_DEFAULTS);
  assert.deepEqual(usageSignalSettings({ thresholdPct: '25', baselineDays: '90', trialDays: '14' }), { thresholdPct: 25, baselineDays: 90, trialDays: 14 });
  assert.deepEqual(usageSignalSettings({ thresholdPct: '0', baselineDays: 'x', trialDays: '1000' }), USAGE_SIGNAL_DEFAULTS);
});

test('the two windows are adjacent halves of the baseline, ending with today', () => {
  const w = dropWindows(NOW, 60);
  assert.equal(w.recent.to.toISOString(), '2026-10-08T00:00:00.000Z');
  assert.equal(w.recent.from.getTime(), w.recent.to.getTime() - 30 * DAY_MS);
  assert.equal(w.prior.to.getTime(), w.recent.from.getTime());
  assert.equal(w.prior.from.getTime(), w.recent.from.getTime() - 30 * DAY_MS);
});

test('drop: at or past the threshold; history must cover the baseline', () => {
  const settings = USAGE_SIGNAL_DEFAULTS;
  const old = day('2026-07-01');
  assert.equal(usageDropVerdict({ recent: 60, prior: 100, firstRowAt: old, now: NOW, settings }), 'drop');
  assert.equal(usageDropVerdict({ recent: 61, prior: 100, firstRowAt: old, now: NOW, settings }), 'ok');
  assert.equal(usageDropVerdict({ recent: 150, prior: 100, firstRowAt: old, now: NOW, settings }), 'ok');
  assert.equal(usageDropVerdict({ recent: 0, prior: 0, firstRowAt: old, now: NOW, settings }), 'ok');
  assert.equal(usageDropVerdict({ recent: 0, prior: 100, firstRowAt: day('2026-09-15'), now: NOW, settings }), 'insufficient_history');
  assert.equal(usageDropVerdict({ recent: 0, prior: 100, firstRowAt: null, now: NOW, settings }), 'insufficient_history');
});

test('trial inactive: N days in with no usage at all', () => {
  const settings = USAGE_SIGNAL_DEFAULTS;
  assert.equal(trialInactive({ trialStartedAt: new Date(NOW.getTime() - 8 * DAY_MS), usageSinceStart: 0, now: NOW, settings }), true);
  assert.equal(trialInactive({ trialStartedAt: new Date(NOW.getTime() - 8 * DAY_MS), usageSinceStart: 3, now: NOW, settings }), false);
  assert.equal(trialInactive({ trialStartedAt: new Date(NOW.getTime() - 6 * DAY_MS), usageSinceStart: 0, now: NOW, settings }), false);
  assert.equal(trialInactive({ trialStartedAt: null, usageSinceStart: 0, now: NOW, settings }), false);
});
