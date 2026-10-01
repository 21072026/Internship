// Standing 1:1 cadence (#2013) — interval weeks and end conditions. No Next, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayNumber, weekdayOf, mondayOf, inCadenceWeek, lastMeetingDay, meetsOn, cadenceEnded } from '../../src/lib/seriesRule.ts';

const D = (s) => new Date(`${s}T00:00:00Z`);
const day = (s) => dayNumber(D(s));
const MON = 1, THU = 4;
const meetingDays = (from, to, days, c) => {
  const out = [];
  for (let d = day(from); d <= day(to); d++) if (meetsOn(d, days, c)) out.push(new Date(d * 86400000).toISOString().slice(0, 10));
  return out;
};

test('calendar arithmetic: weekday and Monday of a date', () => {
  assert.equal(weekdayOf(day('2026-09-30')), 3); // a Wednesday
  assert.equal(new Date(mondayOf(day('2026-10-04')) * 86400000).toISOString().slice(0, 10), '2026-09-28'); // Sunday → its Monday
});

test('interval 1 with no anchor is every week (pre-#2013 behaviour)', () => {
  assert.deepEqual(meetingDays('2026-10-01', '2026-10-21', [MON], {}), ['2026-10-05', '2026-10-12', '2026-10-19']);
});

test('biweekly counts whole weeks from the anchor week and never meets before the anchor', () => {
  const c = { intervalWeeks: 2, anchorDate: D('2026-10-01') }; // a Thursday
  assert.deepEqual(meetingDays('2026-09-20', '2026-11-10', [MON, THU], c), [
    '2026-10-01', // anchor week (the Monday 28 Sep is before the anchor)
    '2026-10-12', '2026-10-15',
    '2026-10-26', '2026-10-29',
    '2026-11-09',
  ]);
});

test('biweekly does not drift across the October DST change (dates, not instants)', () => {
  const c = { intervalWeeks: 2, anchorDate: D('2026-10-19') };
  // Europe ends DST on 2026-10-25; the rule stays on every other Monday.
  assert.deepEqual(meetingDays('2026-10-19', '2026-11-30', [MON], c), ['2026-10-19', '2026-11-02', '2026-11-16', '2026-11-30']);
});

test('4-weekly', () => {
  const c = { intervalWeeks: 4, anchorDate: D('2026-10-05') };
  assert.deepEqual(meetingDays('2026-10-01', '2026-12-31', [MON], c), ['2026-10-05', '2026-11-02', '2026-11-30', '2026-12-28']);
});

test('untilDate is inclusive and ends the rule', () => {
  const c = { anchorDate: D('2026-10-01'), untilDate: D('2026-10-12') };
  assert.deepEqual(meetingDays('2026-10-01', '2026-10-31', [MON], c), ['2026-10-05', '2026-10-12']);
});

test('maxOccurrences counts from the anchor, across all weekdays of the rule', () => {
  const c = { intervalWeeks: 2, anchorDate: D('2026-10-01'), maxOccurrences: 3 };
  assert.deepEqual(meetingDays('2026-09-01', '2026-12-31', [MON, THU], c), ['2026-10-01', '2026-10-12', '2026-10-15']);
  assert.equal(lastMeetingDay([MON, THU], c), day('2026-10-15'));
});

test('both end conditions: the earlier wins; neither = until cancelled', () => {
  const base = { anchorDate: D('2026-10-01') };
  assert.equal(lastMeetingDay([MON], { ...base, maxOccurrences: 10, untilDate: D('2026-10-12') }), day('2026-10-12'));
  assert.equal(lastMeetingDay([MON], { ...base, maxOccurrences: 2, untilDate: D('2026-12-31') }), day('2026-10-12'));
  assert.equal(lastMeetingDay([MON], base), null);
});

test('cadenceEnded is true only once the last meeting day is in the past', () => {
  const c = { anchorDate: D('2026-10-01'), maxOccurrences: 1 };
  assert.equal(cadenceEnded([MON], c, D('2026-10-05')), false);
  assert.equal(cadenceEnded([MON], c, D('2026-10-06')), true);
  assert.equal(cadenceEnded([MON], {}, D('2030-01-01')), false);
});

test('an out-of-range interval falls back to weekly, and a rule before its anchor is silent', () => {
  assert.equal(inCadenceWeek(day('2026-10-12'), { intervalWeeks: 99, anchorDate: D('2026-10-05') }), true);
  assert.equal(inCadenceWeek(day('2026-09-28'), { anchorDate: D('2026-10-05') }), false);
});
