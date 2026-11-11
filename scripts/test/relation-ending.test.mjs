// The end of an agreed pairing and its rhythm (#1786): src/lib/relationEnding.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CADENCE_BEHIND_FACTOR,
  DEFAULT_ENDING_LEAD_DAYS,
  cadenceStatus,
  daysUntilEnd,
  endingLeadDays,
  isEndingSoon,
  originalDurationMonths,
} from '../../src/lib/relationEnding.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-30T09:00:00Z');
const at = (days) => new Date(NOW.getTime() + days * DAY);

test('the lead is a setting with a bounded fallback', () => {
  assert.equal(endingLeadDays(7), 7);
  assert.equal(endingLeadDays('21'), 21);
  for (const bad of [0, -3, 91, 2.5, 'x', null, undefined]) assert.equal(endingLeadDays(bad), DEFAULT_ENDING_LEAD_DAYS);
});

test('ending soon: inside the window, once, and never for a long-past date', () => {
  const r = (days, stamped = null) => ({ expectedEndDate: at(days), endingSoonNotifiedAt: stamped });
  assert.equal(isEndingSoon(r(10), NOW, 14), true);
  assert.equal(isEndingSoon(r(14), NOW, 14), true);
  assert.equal(isEndingSoon(r(15), NOW, 14), false);
  assert.equal(isEndingSoon(r(-0.5), NOW, 14), true, 'the end day itself still counts');
  assert.equal(isEndingSoon(r(-3), NOW, 14), false, 'a date set in the past is not "soon"');
  assert.equal(isEndingSoon(r(5, at(-1)), NOW, 14), false, 'already nudged for this date');
  assert.equal(isEndingSoon({ expectedEndDate: null, endingSoonNotifiedAt: null }, NOW, 14), false);
});

test('daysUntilEnd counts calendar days', () => {
  assert.equal(daysUntilEnd(new Date('2026-11-13T00:00:00Z'), NOW), 14);
  assert.equal(daysUntilEnd(new Date('2026-10-30T00:00:00Z'), NOW), 0);
});

test('no agreed rhythm is no_data — never a signal', () => {
  assert.deepEqual(cadenceStatus({ expectedMeetingIntervalWeeks: null, startDate: at(-400) }, null, NOW), { status: 'no_data', intervalDays: null, daysSince: null });
  assert.equal(cadenceStatus({ expectedMeetingIntervalWeeks: 0, startDate: at(-400) }, null, NOW).status, 'no_data');
});

test('behind only past interval × 1.5 since the last meeting', () => {
  const rel = { expectedMeetingIntervalWeeks: 2, startDate: at(-200) };
  const limit = 14 * CADENCE_BEHIND_FACTOR; // 21 days
  assert.equal(cadenceStatus(rel, at(-limit), NOW).status, 'on_track');
  assert.deepEqual(cadenceStatus(rel, at(-(limit + 1)), NOW), { status: 'behind', intervalDays: 14, daysSince: 22 });
});

test('a pair that never met is measured from its start', () => {
  assert.equal(cadenceStatus({ expectedMeetingIntervalWeeks: 1, startDate: at(-5) }, null, NOW).status, 'on_track');
  assert.equal(cadenceStatus({ expectedMeetingIntervalWeeks: 1, startDate: at(-11) }, null, NOW).status, 'behind');
});

test('original duration is whole months, at least one', () => {
  assert.equal(originalDurationMonths(new Date('2026-01-15T00:00:00Z'), new Date('2026-07-15T00:00:00Z')), 6);
  assert.equal(originalDurationMonths(new Date('2026-01-15T00:00:00Z'), new Date('2026-01-30T00:00:00Z')), 1);
});
