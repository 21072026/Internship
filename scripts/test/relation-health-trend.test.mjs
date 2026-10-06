// Unit tests for relationship-health history (#1901): the one-alert-per-
// crossing rule and the trend/delta arithmetic.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { shouldAlert, healthTrendFrom, utcDay, ALERT_REPEAT_DAYS } = await import('../../src/lib/relationHealthTrend.ts');

const DAY = 24 * 60 * 60 * 1000;
const today = new Date('2026-10-07T00:00:00Z');
const daysAgo = (n) => new Date(today.getTime() - n * DAY);

test('a crossing into AT_RISK alerts; staying red does not, until the repeat window', () => {
  assert.equal(shouldAlert({ today, todayBand: 'AT_RISK', yesterdayBand: 'WATCH', lastAlertOn: null }), true);
  assert.equal(shouldAlert({ today, todayBand: 'AT_RISK', yesterdayBand: 'HEALTHY', lastAlertOn: daysAgo(3) }), true, 'recovered and fell again');
  assert.equal(shouldAlert({ today, todayBand: 'AT_RISK', yesterdayBand: 'AT_RISK', lastAlertOn: daysAgo(1) }), false);
  assert.equal(shouldAlert({ today, todayBand: 'AT_RISK', yesterdayBand: 'AT_RISK', lastAlertOn: daysAgo(ALERT_REPEAT_DAYS - 1) }), false);
  assert.equal(shouldAlert({ today, todayBand: 'AT_RISK', yesterdayBand: 'AT_RISK', lastAlertOn: daysAgo(ALERT_REPEAT_DAYS) }), true);
});

test('no snapshot yesterday is a baseline, not a crossing — the first sweep mails nobody', () => {
  assert.equal(shouldAlert({ today, todayBand: 'AT_RISK', yesterdayBand: null, lastAlertOn: null }), false);
  assert.equal(shouldAlert({ today, todayBand: 'AT_RISK', yesterdayBand: 'AT_RISK', lastAlertOn: null }), false);
});

test('only AT_RISK alerts', () => {
  assert.equal(shouldAlert({ today, todayBand: 'WATCH', yesterdayBand: 'HEALTHY', lastAlertOn: null }), false);
});

test('the trend is the measured series and the 7/30-day delta, never interpolated', () => {
  const snaps = [
    { takenOn: daysAgo(40), score: 90, band: 'HEALTHY' },
    { takenOn: daysAgo(30), score: 80, band: 'HEALTHY' },
    { takenOn: daysAgo(8), score: 70, band: 'HEALTHY' }, // no snapshot exactly 7 days ago
    { takenOn: daysAgo(1), score: 50, band: 'WATCH' },
    { takenOn: today, score: 35, band: 'AT_RISK' },
  ];
  const t = healthTrendFrom(snaps, 30, today);
  // The 30-day window starts 2026-09-08: the snapshots 30 and 40 days back are outside it.
  assert.deepEqual(t.series.map((p) => p.day), ['2026-09-29', '2026-10-06', '2026-10-07']);
  assert.equal(t.delta7, 35 - 70, 'latest on or before the target day');
  assert.equal(t.delta30, 35 - 80);
  assert.deepEqual(healthTrendFrom([], 90, today), { series: [], delta7: null, delta30: null });
  assert.equal(healthTrendFrom([{ takenOn: today, score: 60, band: 'WATCH' }], 90, today).delta7, null);
});

test('utcDay is midnight UTC', () => {
  assert.equal(utcDay(new Date('2026-10-07T23:59:59Z')).toISOString(), '2026-10-07T00:00:00.000Z');
});
