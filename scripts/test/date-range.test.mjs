// Unit tests for the shared `?from=&to=` parser (#1501).
//
// Run: node --test --experimental-strip-types scripts/test/date-range.test.mjs
// (also covered by `npm run test:unit`).
//
// The bug: `new Date('2026-09-23')` is the FIRST instant of that day, so using
// it as an `lte` upper bound drops everything that happened during the day the
// caller picked. The default admin analytics preset sends exactly that, and on
// a database whose rows were all created today the trends chart was twelve
// bars of zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeStart, rangeEnd } from '../../src/lib/dateRange.ts';

test('a date-only bound covers the whole day it names', () => {
  const start = rangeStart('2026-09-23');
  const end = rangeEnd('2026-09-23');
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds(), 0);
  assert.equal(start.getMilliseconds(), 0);
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
  assert.equal(end.getSeconds(), 59);
  assert.equal(end.getMilliseconds(), 999);
  // Same calendar day at both ends, and a full day between them.
  assert.equal(end.getDate(), start.getDate());
  assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000 - 1);
});

test('an event during the named day falls inside the range', () => {
  // The regression itself: "today at 11:23" against a range ending "today".
  const at = new Date(2026, 8, 23, 11, 23, 9, 108);
  assert.ok(at >= rangeStart('2026-09-23'));
  assert.ok(at <= rangeEnd('2026-09-23'), 'an event today must fall inside a range that ends today');
});

test('the bound is inclusive, not the next midnight', () => {
  // 23:59:59.999 rather than the next day's 00:00 — the callers compare with
  // `lte` (and some compare in JS), so an exclusive bound would be a trap.
  const end = rangeEnd('2026-09-23');
  assert.ok(end < new Date(2026, 8, 24, 0, 0, 0, 0));
  assert.ok(new Date(2026, 8, 24, 0, 0, 0, 0) > end, 'the next day must not be inside the range');
});

test('a bound that carries a time is taken literally', () => {
  const end = rangeEnd('2026-09-23T14:30:00.000Z');
  assert.equal(end.toISOString(), '2026-09-23T14:30:00.000Z');
  const start = rangeStart('2026-09-23T14:30:00.000Z');
  assert.equal(start.toISOString(), '2026-09-23T14:30:00.000Z');
});

test('a missing or unparseable bound is null, never an Invalid Date', () => {
  for (const bad of [null, undefined, '', 'yesterday', '2026-13-45T99:99', 'not-a-date']) {
    assert.equal(rangeStart(bad), null, `rangeStart(${JSON.stringify(bad)})`);
    assert.equal(rangeEnd(bad), null, `rangeEnd(${JSON.stringify(bad)})`);
  }
  // A caller falls back to its own default on null, rather than 500ing — so
  // "Invalid Date" leaking through would be the failure mode that matters.
});

test('a date-only bound survives a month or year boundary', () => {
  assert.equal(rangeEnd('2026-02-28').getDate(), 28);
  assert.equal(rangeEnd('2026-12-31').getMonth(), 11);
  assert.equal(rangeEnd('2026-12-31').getFullYear(), 2026);
  // Leap day, since the parser builds the date from parts rather than parsing.
  assert.equal(rangeStart('2028-02-29').getDate(), 29);
});
