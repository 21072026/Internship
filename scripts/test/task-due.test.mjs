// Unit tests for the to-do due-date rule (#2440).
//
// Run: node --test --experimental-strip-types scripts/test/task-due.test.mjs
// (also covered by `npm run test:unit`).
//
// The two rules the issue calls load-bearing are exactly what is pinned here:
// "late" is a CALENDAR DAY before today (a to-do due today at 09:00 is not late
// in the afternoon), and a date-only value names its day in UTC while "today"
// is the reader's own local day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// `taskDue.ts` imports `./stageClock` for DAY_MS, and that one imports
// `./pipeline` / `./offers` — specifiers the app's bundler resolves and Node's
// ESM resolver does not. The hook closes that gap and must be installed before
// the module loads, hence the dynamic import.
register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { taskDueState, isTaskOverdue, countOverdueTasks, overdueBefore } = await import('../../src/lib/taskDue.ts');

// A fixed "now": 22 September 2026, late afternoon on the local clock.
const now = new Date(2026, 8, 22, 17, 30, 0);
const day = (iso) => new Date(iso);

test('a to-do due today is not late, at any time of day', () => {
  // The date as an <input type="date"> stores it: UTC midnight of that day.
  assert.equal(taskDueState(day('2026-09-22T00:00:00.000Z'), now).tone, 'today');
  assert.equal(taskDueState(day('2026-09-22T00:00:00.000Z'), now).overdue, false);
  // And with a time of day on it — 09:00, long past by 17:30 — still not late.
  assert.equal(taskDueState(day('2026-09-22T09:00:00.000Z'), now).overdue, false);
  // Even at one minute to midnight local.
  const almostMidnight = new Date(2026, 8, 22, 23, 59, 0);
  assert.equal(taskDueState(day('2026-09-22T09:00:00.000Z'), almostMidnight).overdue, false);
});

test('yesterday is late, tomorrow is not', () => {
  const yesterday = taskDueState(day('2026-09-21T00:00:00.000Z'), now);
  assert.equal(yesterday.overdue, true);
  assert.equal(yesterday.tone, 'overdue');
  assert.equal(yesterday.days, -1);

  const tomorrow = taskDueState(day('2026-09-23T00:00:00.000Z'), now);
  assert.equal(tomorrow.overdue, false);
  assert.equal(tomorrow.tone, 'upcoming');
  assert.equal(tomorrow.days, 1);

  assert.equal(taskDueState(day('2026-09-12T00:00:00.000Z'), now).days, -10);
});

test('no date is no state — not an error, and never late', () => {
  assert.equal(taskDueState(null, now), null);
  assert.equal(taskDueState(undefined, now), null);
  assert.equal(taskDueState('', now), null);
  assert.equal(taskDueState('not a date', now), null);
  assert.equal(isTaskOverdue({ dueDate: null }, now), false);
  assert.equal(isTaskOverdue(null, now), false);
});

test('a finished to-do is never late, whatever its date says', () => {
  assert.equal(isTaskOverdue({ dueDate: '2026-09-01T00:00:00.000Z', done: true }, now), false);
  assert.equal(isTaskOverdue({ dueDate: '2026-09-01T00:00:00.000Z', done: false }, now), true);
});

test('the counter counts only the open, dated, past ones', () => {
  const list = [
    { dueDate: '2026-09-20T00:00:00.000Z', done: false }, // late
    { dueDate: '2026-09-21T00:00:00.000Z', done: false }, // late
    { dueDate: '2026-09-22T00:00:00.000Z', done: false }, // today — not late
    { dueDate: '2026-09-30T00:00:00.000Z', done: false }, // upcoming
    { dueDate: '2026-01-01T00:00:00.000Z', done: true }, // finished
    { dueDate: null, done: false }, // undated
  ];
  assert.equal(countOverdueTasks(list, now), 2);
  assert.equal(countOverdueTasks([], now), 0);
});

test('the query bound excludes today and includes yesterday', () => {
  const bound = overdueBefore(now);
  // Midnight UTC of the reader's own day.
  assert.equal(bound.toISOString(), '2026-09-22T00:00:00.000Z');
  // `dueDate < bound` is the SQL: today's row is not selected, yesterday's is.
  assert.equal(day('2026-09-22T00:00:00.000Z') < bound, false);
  assert.equal(day('2026-09-21T00:00:00.000Z') < bound, true);
});

test('a string is read the same way a Date is', () => {
  assert.equal(taskDueState('2026-09-21T00:00:00.000Z', now).overdue, true);
  assert.equal(taskDueState('2026-09-23T00:00:00.000Z', now).overdue, false);
  // A bare date string is UTC midnight too — the shape the API receives.
  assert.equal(taskDueState('2026-09-21', now).days, -1);
});
