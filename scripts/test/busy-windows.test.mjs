import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./ts-extensionless-resolve.mjs', import.meta.url);

const { overlaps, mergeWindows, firstConflict, filterBookedOccurrences } = await import('../../src/lib/busyWindowsRule.ts');

const w = (s, e, title = '') => ({ start: new Date(s), end: new Date(e), title });

test('half-open: back to back is not a clash, any shared instant is', () => {
  assert.equal(overlaps(w('2026-10-06T09:00Z', '2026-10-06T10:00Z'), w('2026-10-06T10:00Z', '2026-10-06T11:00Z')), false);
  assert.equal(overlaps(w('2026-10-06T09:00Z', '2026-10-06T10:01Z'), w('2026-10-06T10:00Z', '2026-10-06T11:00Z')), true);
  assert.equal(overlaps(w('2026-10-06T09:00Z', '2026-10-06T12:00Z'), w('2026-10-06T10:00Z', '2026-10-06T11:00Z')), true); // contains
  assert.equal(overlaps(w('2026-10-06T10:00Z', '2026-10-06T11:00Z'), w('2026-10-06T10:00Z', '2026-10-06T11:00Z')), true); // identical
});

test('merging: overlaps fuse, adjacency stays apart, empty windows vanish', () => {
  const merged = mergeWindows([
    w('2026-10-06T10:30Z', '2026-10-06T11:30Z'),
    w('2026-10-06T09:00Z', '2026-10-06T10:45Z'),
    w('2026-10-06T11:30Z', '2026-10-06T12:00Z'),
    w('2026-10-06T13:00Z', '2026-10-06T13:00Z'),
  ]);
  assert.deepEqual(merged.map((m) => [m.start.toISOString(), m.end.toISOString()]), [
    ['2026-10-06T09:00:00.000Z', '2026-10-06T11:30:00.000Z'],
    ['2026-10-06T11:30:00.000Z', '2026-10-06T12:00:00.000Z'],
  ]);
});

test('a DST change does not move absolute instants', () => {
  // Berlin leaves summer time at 03:00 CEST on 2026-10-25 → 02:00 CET happens twice.
  // 01:30–02:30 CET (00:30–01:30 UTC) and 02:30 CEST–02:15 CET (00:30–01:15 UTC) overlap;
  // the wall clocks would suggest they do not.
  const before = w('2026-10-25T00:30Z', '2026-10-25T01:15Z');
  const after = w('2026-10-25T00:30Z', '2026-10-25T01:30Z');
  assert.equal(overlaps(before, after), true);
  // And one hour after the change is back to back with the hour before it.
  assert.equal(overlaps(w('2026-10-25T01:00Z', '2026-10-25T02:00Z'), w('2026-10-25T02:00Z', '2026-10-25T03:00Z')), false);
});

test('the first conflict is named; free slots survive the filter', () => {
  const busy = [w('2026-10-06T14:00Z', '2026-10-06T15:00Z', 'Later'), w('2026-10-06T10:00Z', '2026-10-06T11:00Z', 'Weekly 1:1')];
  assert.equal(firstConflict(w('2026-10-06T10:30Z', '2026-10-06T14:30Z'), busy).title, 'Weekly 1:1');
  assert.equal(firstConflict(w('2026-10-06T11:00Z', '2026-10-06T14:00Z'), busy), null);
  const slots = [w('2026-10-06T09:00Z', '2026-10-06T10:00Z'), w('2026-10-06T10:00Z', '2026-10-06T11:00Z'), w('2026-10-06T11:00Z', '2026-10-06T12:00Z')];
  assert.deepEqual(filterBookedOccurrences(slots, busy).map((s) => s.start.toISOString()), ['2026-10-06T09:00:00.000Z', '2026-10-06T11:00:00.000Z']);
});
