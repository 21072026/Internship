// Unit tests for the match-time agreement (#1784) — src/lib/relationSchedule.ts.
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endDateFromDuration, parseSchedule, DURATION_PRESETS_MONTHS, CADENCE_PRESETS_WEEKS } from '../../src/lib/relationSchedule.ts';

const START = new Date('2026-01-31T10:00:00Z');

test('a duration is calendar months, clamped to the target month', () => {
  assert.equal(endDateFromDuration(START, 1).toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(endDateFromDuration(START, 6).toISOString(), '2026-07-31T00:00:00.000Z');
  assert.equal(endDateFromDuration(new Date('2026-10-21T00:00:00Z'), 12).toISOString(), '2027-10-21T00:00:00.000Z');
  assert.deepEqual([...DURATION_PRESETS_MONTHS], [3, 6, 12]);
  assert.deepEqual([...CADENCE_PRESETS_WEEKS], [1, 2, 4]);
});

test('only what was sent comes back — an absent field never overwrites', () => {
  assert.deepEqual(parseSchedule({}, START), { ok: true, data: {} });
  assert.deepEqual(parseSchedule({ expectedMeetingIntervalWeeks: 2 }, START), { ok: true, data: { expectedMeetingIntervalWeeks: 2 } });
  assert.deepEqual(parseSchedule({ expectedEndDate: null, expectedMeetingIntervalWeeks: null }, START), {
    ok: true,
    data: { expectedEndDate: null, expectedMeetingIntervalWeeks: null },
  });
});

test('an explicit end date wins over a duration', () => {
  const r = parseSchedule({ expectedEndDate: '2026-05-01', durationMonths: 12 }, START);
  assert.equal(r.ok, true);
  assert.equal(r.data.expectedEndDate.toISOString(), '2026-05-01T00:00:00.000Z');
  const d = parseSchedule({ durationMonths: 6 }, START);
  assert.equal(d.data.expectedEndDate.toISOString(), '2026-07-31T00:00:00.000Z');
});

test('refusals name the field', () => {
  assert.equal(parseSchedule({ expectedEndDate: 'soon' }, START).code, 'invalid_end_date');
  assert.equal(parseSchedule({ expectedEndDate: '2025-12-01' }, START).code, 'end_before_start');
  assert.equal(parseSchedule({ expectedEndDate: '2032-01-01' }, START).code, 'end_too_far');
  assert.equal(parseSchedule({ durationMonths: 0 }, START).code, 'invalid_duration');
  assert.equal(parseSchedule({ durationMonths: 61 }, START).code, 'invalid_duration');
  assert.equal(parseSchedule({ durationMonths: 2.5 }, START).code, 'invalid_duration');
  assert.equal(parseSchedule({ expectedMeetingIntervalWeeks: 0 }, START).code, 'invalid_cadence');
  assert.equal(parseSchedule({ expectedMeetingIntervalWeeks: 53 }, START).code, 'invalid_cadence');
  // The start day itself is a valid end (a one-day pairing is odd, not invalid).
  assert.equal(parseSchedule({ expectedEndDate: '2026-01-31' }, START).ok, true);
});
