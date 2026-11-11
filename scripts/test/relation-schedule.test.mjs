// What a pairing agreed to (#1784): src/lib/relationSchedule.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonthsUtc,
  parseEndDate,
  sanitizeDefaults,
  scheduleCreateData,
  scheduleOnProgrammeJoin,
} from '../../src/lib/relationSchedule.ts';

const day = (d) => d?.toISOString().slice(0, 10) ?? d;
const START = new Date('2026-01-31T15:00:00Z');
const NONE = { durationMonths: null, cadenceWeeks: null };

test('addMonthsUtc clamps the 31st to the end of a shorter month', () => {
  assert.equal(day(addMonthsUtc(START, 1)), '2026-02-28');
  assert.equal(day(addMonthsUtc(START, 6)), '2026-07-31');
  assert.equal(day(addMonthsUtc(new Date('2026-11-15T00:00:00Z'), 3)), '2027-02-15');
});

test('parseEndDate accepts real calendar days only', () => {
  assert.equal(day(parseEndDate('2026-03-14')), '2026-03-14');
  assert.equal(day(parseEndDate('2026-03-14T22:00:00Z')), '2026-03-14');
  assert.equal(parseEndDate('2026-02-30'), null);
  assert.equal(parseEndDate('14.03.2026'), null);
});

test('nothing chosen and nothing configured writes nothing (pre-#1784 rows)', () => {
  assert.deepEqual(scheduleCreateData({}, START, NONE), {});
});

test('an explicit end day beats a duration, a duration beats the default', () => {
  const defaults = { durationMonths: 12, cadenceWeeks: 4 };
  assert.equal(day(scheduleCreateData({ expectedEndDate: '2026-05-01', durationMonths: 3 }, START, defaults).expectedEndDate), '2026-05-01');
  assert.equal(day(scheduleCreateData({ durationMonths: 6 }, START, defaults).expectedEndDate), '2026-07-31');
  const d = scheduleCreateData({}, START, defaults);
  assert.equal(day(d.expectedEndDate), '2027-01-31');
  assert.equal(d.expectedMeetingIntervalWeeks, 4);
});

test('an explicit null opts out of the default', () => {
  const d = scheduleCreateData({ expectedEndDate: null, expectedMeetingIntervalWeeks: null }, START, { durationMonths: 6, cadenceWeeks: 2 });
  assert.deepEqual(d, { expectedEndDate: null, expectedMeetingIntervalWeeks: null });
});

test('joining a programme fills only what is still empty and not set by the request', () => {
  const defaults = { durationMonths: 3, cadenceWeeks: 2 };
  const empty = { startDate: START, expectedEndDate: null, expectedMeetingIntervalWeeks: null };
  assert.deepEqual(
    Object.fromEntries(Object.entries(scheduleOnProgrammeJoin(empty, {}, defaults)).map(([k, v]) => [k, v instanceof Date ? day(v) : v])),
    { expectedEndDate: '2026-04-30', expectedMeetingIntervalWeeks: 2 },
  );
  const agreed = { startDate: START, expectedEndDate: new Date('2026-09-01T00:00:00Z'), expectedMeetingIntervalWeeks: 1 };
  assert.deepEqual(scheduleOnProgrammeJoin(agreed, {}, defaults), {});
  assert.deepEqual(scheduleOnProgrammeJoin(empty, { expectedEndDate: null, expectedMeetingIntervalWeeks: 4 }, defaults), {});
});

test('configured defaults outside the form bounds read as none', () => {
  assert.deepEqual(sanitizeDefaults({ durationMonths: 0, cadenceWeeks: 99 }), NONE);
  assert.deepEqual(sanitizeDefaults({ durationMonths: null, cadenceWeeks: 2.5 }), NONE);
  assert.deepEqual(sanitizeDefaults({ durationMonths: 6, cadenceWeeks: 2 }), { durationMonths: 6, cadenceWeeks: 2 });
});
