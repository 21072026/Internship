import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { relationCadence, programmeAttendance, CADENCE_MIN_GROUP } = await import('../../src/lib/meetingCadence.ts');

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-06T12:00:00Z');
const ago = (d) => new Date(now.getTime() - d * DAY);
const m = (relationId, d, noShow = false) => ({ relationId, at: ago(d), noShow });

test('one pair: on cadence inside the promised interval, off it after, null without a promise', () => {
  assert.deepEqual(relationCadence(2, [m('r', 10)], now), { lastMetAt: ago(10), daysSinceLastMet: 10, onCadence: true });
  assert.equal(relationCadence(2, [m('r', 15)], now).onCadence, false);
  assert.equal(relationCadence(2, [m('r', 14)], now).onCadence, true); // inclusive
  assert.equal(relationCadence(null, [m('r', 99)], now).onCadence, null);
  assert.equal(relationCadence(2, [], now).onCadence, false); // promised, never met
});

test('a no-show is not a meeting, and neither is one in the future', () => {
  assert.equal(relationCadence(2, [m('r', 3, true), m('r', 20)], now).daysSinceLastMet, 20);
  assert.equal(relationCadence(2, [m('r', -2)], now).lastMetAt, null);
});

test('programme figures: met in 30 days, on cadence, no-show rate and the median gap', () => {
  const pairs = ['a', 'b', 'c', 'd', 'e', 'f'].map((relationId, i) => ({ relationId, expectedIntervalWeeks: i < 5 ? 2 : null }));
  const meetings = [
    m('a', 5), m('a', 19), m('a', 33), // gaps 14, 14
    m('b', 10), m('b', 40),            // gap 30
    m('c', 45),                        // not recent
    m('d', 2, true), m('d', 60),       // a no-show, then old
    m('e', 12),
    m('f', 1),                         // no promise
  ];
  const r = programmeAttendance(pairs, meetings, now);
  assert.equal(r.activePairs, 6);
  // a, b, e, f met in the last 30 days (d's recent one was a no-show) → 4/6.
  assert.deepEqual(r.metRecently, { pct: 67, basis: 6 });
  // Promised: a..e. On cadence (≤ 14 days): a (5), b (10), e (12) → 3/5.
  assert.deepEqual(r.onCadence, { pct: 60, basis: 5 });
  // Last 90 days: all 10 meetings, 1 no-show → 10 %.
  assert.deepEqual(r.noShowRate, { pct: 10, basis: 10 });
  // Gaps 14, 14, 30 → median 14.
  assert.equal(r.medianDaysBetween, 14);
});

test('a small programme is suppressed, not published', () => {
  const pairs = ['a', 'b'].map((relationId) => ({ relationId, expectedIntervalWeeks: 2 }));
  const r = programmeAttendance(pairs, [m('a', 3), m('b', 4), m('a', 10)], now);
  assert.equal(CADENCE_MIN_GROUP, 5);
  assert.deepEqual(r.metRecently, { pct: null, basis: 2 });
  assert.equal(r.onCadence.pct, null);
  assert.equal(r.noShowRate.pct, null);
  assert.equal(r.medianDaysBetween, null);
});
