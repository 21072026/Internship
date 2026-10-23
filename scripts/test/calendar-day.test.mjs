// Unit tests for parseCalendarDay (src/lib/calendarDay.ts, #3116).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendarDay } from '../../src/lib/calendarDay.ts';

test('a real day is its UTC midnight', () => {
  assert.equal(parseCalendarDay('2026-03-01')?.toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(parseCalendarDay('2028-02-29')?.toISOString(), '2028-02-29T00:00:00.000Z');
});

test('an impossible day is refused, never rolled over', () => {
  for (const v of ['2026-02-31', '2026-04-31', '2026-02-29', '2026-13-01', '2026-00-10', '2026-01-00']) assert.equal(parseCalendarDay(v), null, v);
});

test('anything but YYYY-MM-DD is refused', () => {
  for (const v of ['2026-3-1', '01.03.2026', '2026-03-01T00:00:00Z', '', null, 20260301]) assert.equal(parseCalendarDay(v), null, String(v));
});
