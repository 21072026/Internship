// A meeting series as one recurring Google event (#2654) — the RRULE. No Next, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyRrule, weekdays } from '../../src/lib/seriesRrule.ts';

test('weekdays map to BYDAY in week order, Sunday = 0', () => {
  assert.equal(weeklyRrule([1, 4]), 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH');
  assert.equal(weeklyRrule([0, 6]), 'RRULE:FREQ=WEEKLY;BYDAY=SU,SA');
  assert.equal(weeklyRrule([5, 1, 3]), 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
});

test('duplicates and junk are dropped; stored JSON strings read as numbers', () => {
  assert.deepEqual(weekdays([1, 1, '3', 9, -1, 2.5, null]), [1, 3]);
  assert.equal(weeklyRrule(['2', 2]), 'RRULE:FREQ=WEEKLY;BYDAY=TU');
});

test('a rule with no valid weekday has no RRULE', () => {
  assert.equal(weeklyRrule([]), null);
  assert.equal(weeklyRrule(null), null);
  assert.equal(weeklyRrule('1,4'), null);
  assert.equal(weeklyRrule([7, 8]), null);
});
