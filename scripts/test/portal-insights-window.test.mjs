// Unit tests for the mentee's own report window (#1909, src/lib/portalInsightsWindow.ts).
//
// Run: node --test --experimental-strip-types scripts/test/portal-insights-window.test.mjs
//
// What a reviewer cannot keep in their head: a range wins over a preset, and a
// bad or inverted range falls back to the default seven days — never an error
// and never an empty period that reads as "you did nothing".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PORTAL_INSIGHTS_DAYS, resolveInsightsWindow, ymd } from '../../src/lib/portalInsightsWindow.ts';

const now = new Date('2026-11-06T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const none = { from: null, to: null, days: null, rangeAsked: false };

test('no query is the last seven days', () => {
  assert.deepEqual(resolveInsightsWindow(none, now), { from: new Date(now.getTime() - 7 * DAY), to: now, days: 7 });
});

test('a preset is one of 1, 7, 30; anything else is seven', () => {
  assert.deepEqual([...PORTAL_INSIGHTS_DAYS], [1, 7, 30]);
  for (const d of [1, 7, 30]) assert.equal(resolveInsightsWindow({ ...none, days: String(d) }, now).days, d);
  for (const d of ['0', '365', 'x', '']) assert.equal(resolveInsightsWindow({ ...none, days: d }, now).days, 7);
});

test('a date range is taken as given and wins over a preset', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const to = new Date('2026-03-31T23:59:59.999Z');
  assert.deepEqual(resolveInsightsWindow({ from, to, days: '30', rangeAsked: true }, now), { from, to, days: null });
});

test('a missing bound: no `to` is now, no `from` is seven days before `to`', () => {
  const from = new Date('2026-10-01T00:00:00Z');
  assert.deepEqual(resolveInsightsWindow({ ...none, from, rangeAsked: true }, now), { from, to: now, days: null });
  const to = new Date('2026-10-20T23:59:59.999Z');
  assert.deepEqual(resolveInsightsWindow({ ...none, to, rangeAsked: true }, now), { from: new Date(to.getTime() - 7 * DAY), to, days: null });
});

test('an unparseable or inverted range falls back to the default, not an error', () => {
  assert.equal(resolveInsightsWindow({ ...none, rangeAsked: true }, now).days, 7);
  const inverted = { from: new Date('2026-10-20T00:00:00Z'), to: new Date('2026-10-01T23:59:59Z'), days: null, rangeAsked: true };
  assert.deepEqual(resolveInsightsWindow(inverted, now), { from: new Date(now.getTime() - 7 * DAY), to: now, days: 7 });
});

test('ymd is the date an <input type="date"> holds', () => {
  assert.equal(ymd(new Date('2026-03-05T10:00:00Z')), '2026-03-05');
});
