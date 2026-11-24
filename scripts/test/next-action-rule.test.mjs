// Unit tests for the per-record "next action + follow-up date" rule (#2563).
//
// The three things that go wrong silently here are all date arithmetic:
//   • "due" computed from a raw timestamp makes the reminder depend on the hour
//     the daily tick runs;
//   • the queue flag and the reminder firing on the same day would make the
//     record look late on the very day it is due;
//   • a date edit that does not re-arm the reminder (or a note edit that does)
//     either drops the new date's reminder or mails the owner twice.
// None of it is reachable from a browser, so it is pinned here with a fixed
// clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEXT_ACTION_NOTE_MAX,
  canSeeNextAction,
  isNextActionOverdue,
  isNextActionReminderDue,
  nextActionDueBefore,
  nextActionOverdueBefore,
  compareNextActions,
  nextActionPatch,
  parseNextActionDate,
  parseNextActionNote,
  parseNextActionTime,
  stripNextActionFor,
} from '../../src/lib/nextActionRule.ts';

// Late in the UTC day on purpose: the arrangement where a timestamp comparison
// and a calendar-day comparison disagree.
const NOW = new Date('2026-03-12T22:30:00.000Z');
const day = (s) => new Date(`${s}T00:00:00.000Z`);

test('parseNextActionDate reads YYYY-MM-DD as midnight UTC and clears on null/empty', () => {
  assert.deepEqual(parseNextActionDate('2026-03-12'), { ok: true, value: day('2026-03-12') });
  assert.deepEqual(parseNextActionDate(' 2026-03-12 '), { ok: true, value: day('2026-03-12') });
  assert.deepEqual(parseNextActionDate(null), { ok: true, value: null });
  assert.deepEqual(parseNextActionDate(''), { ok: true, value: null });
});

test('parseNextActionDate refuses timestamps, impossible dates and non-strings', () => {
  for (const bad of ['2026-03-12T10:00:00Z', '2026-02-30', '12.03.2026', '1999-12-31', '2101-01-01', 42, {}]) {
    assert.deepEqual(parseNextActionDate(bad), { ok: false, error: 'invalid_date' }, String(bad));
  }
});

test('parseNextActionNote trims, blanks to null, refuses (never truncates) over the column width', () => {
  assert.deepEqual(parseNextActionNote('  call about pricing '), { ok: true, value: 'call about pricing' });
  assert.deepEqual(parseNextActionNote('   '), { ok: true, value: null });
  assert.deepEqual(parseNextActionNote(null), { ok: true, value: null });
  assert.deepEqual(parseNextActionNote('x'.repeat(NEXT_ACTION_NOTE_MAX)), { ok: true, value: 'x'.repeat(NEXT_ACTION_NOTE_MAX) });
  assert.deepEqual(parseNextActionNote('x'.repeat(NEXT_ACTION_NOTE_MAX + 1)), { ok: false, error: 'too_long' });
});

test('the reminder is due on the day itself, whatever hour the tick runs', () => {
  const today = { nextActionAt: day('2026-03-12'), nextActionRemindedAt: null };
  assert.equal(isNextActionReminderDue(today, NOW), true);
  assert.equal(isNextActionReminderDue(today, new Date('2026-03-12T00:00:01Z')), true);
  // Tomorrow is not due, even 90 minutes before midnight.
  assert.equal(isNextActionReminderDue({ nextActionAt: day('2026-03-13'), nextActionRemindedAt: null }, NOW), false);
});

test('a missed tick is caught up, but a date already reminded never re-sends', () => {
  const missed = { nextActionAt: day('2026-03-10'), nextActionRemindedAt: null };
  assert.equal(isNextActionReminderDue(missed, NOW), true);
  assert.equal(isNextActionReminderDue({ ...missed, nextActionRemindedAt: day('2026-03-10') }, NOW), false);
  assert.equal(isNextActionReminderDue({ nextActionAt: null, nextActionRemindedAt: null }, NOW), false);
});

test('overdue starts the day AFTER the reminder — never on the due day', () => {
  assert.equal(isNextActionOverdue(day('2026-03-12'), NOW), false);
  assert.equal(isNextActionOverdue(day('2026-03-11'), NOW), true);
  assert.equal(isNextActionOverdue(day('2026-03-13'), NOW), false);
  assert.equal(isNextActionOverdue(null, NOW), false);
});

test('query bounds agree with the predicates', () => {
  assert.equal(nextActionDueBefore(NOW).toISOString(), '2026-03-13T00:00:00.000Z');
  assert.equal(nextActionOverdueBefore(NOW).toISOString(), '2026-03-12T00:00:00.000Z');
});

test('moving the date re-arms the reminder; editing only the note does not', () => {
  const current = { nextActionAt: day('2026-03-12') };
  assert.deepEqual(nextActionPatch(current, { nextActionAt: day('2026-03-19') }), {
    nextActionAt: day('2026-03-19'),
    nextActionRemindedAt: null,
  });
  // Clearing the day clears its time of day too (#3901).
  assert.deepEqual(nextActionPatch(current, { nextActionAt: null }), { nextActionAt: null, nextActionRemindedAt: null, nextActionTime: null });
  assert.deepEqual(nextActionPatch(current, { nextActionAt: day('2026-03-12'), nextActionNote: 'typo fixed' }), {
    nextActionAt: day('2026-03-12'),
    nextActionNote: 'typo fixed',
  });
  assert.deepEqual(nextActionPatch(current, {}), {});
});

test('only the owner and ADMIN see the next-action columns', () => {
  const row = { id: 'r1', mentorId: 'owner', nextActionAt: day('2026-03-12'), nextActionNote: 'n', nextActionRemindedAt: null };
  assert.equal(canSeeNextAction({ id: 'owner', role: 'MENTOR' }, row), true);
  assert.equal(canSeeNextAction({ id: 'someone', role: 'ADMIN' }, row), true);
  assert.equal(canSeeNextAction({ id: 'mentee', role: 'MENTEE' }, row), false);
  assert.deepEqual(stripNextActionFor({ id: 'mentee', role: 'MENTEE' }, row), { id: 'r1', mentorId: 'owner' });
  assert.equal(stripNextActionFor({ id: 'owner', role: 'MENTOR' }, row), row);
});

// ── Time of day (#3901) ─────────────────────────────────────────────────────

test('a time of day is HH:MM on the 24-hour clock, or nothing', () => {
  assert.deepEqual(parseNextActionTime('09:30'), { ok: true, value: '09:30' });
  assert.deepEqual(parseNextActionTime('23:59'), { ok: true, value: '23:59' });
  // <input type="time"> may send seconds; they are dropped.
  assert.deepEqual(parseNextActionTime('14:05:00'), { ok: true, value: '14:05' });
  for (const blank of [null, undefined, '']) assert.deepEqual(parseNextActionTime(blank), { ok: true, value: null });
  for (const bad of ['24:00', '9:30', '12:60', '1230', 'noon', 930, '12:30 PM']) {
    assert.deepEqual(parseNextActionTime(bad), { ok: false, error: 'invalid_time' }, String(bad));
  }
});

test('a time never moves the day, never re-arms the reminder, and dies with the day', () => {
  const current = { nextActionAt: day('2026-03-12') };
  // Changing only the time keeps the reminder already sent for that day.
  assert.deepEqual(nextActionPatch(current, { nextActionTime: '10:00' }), { nextActionTime: '10:00' });
  assert.deepEqual(nextActionPatch(current, { nextActionAt: day('2026-03-12'), nextActionTime: '15:00' }), {
    nextActionAt: day('2026-03-12'),
    nextActionTime: '15:00',
  });
  // A time sent with the day cleared, or onto a record that has no day, is dropped.
  assert.deepEqual(nextActionPatch(current, { nextActionAt: null, nextActionTime: '10:00' }), {
    nextActionAt: null,
    nextActionRemindedAt: null,
    nextActionTime: null,
  });
  assert.deepEqual(nextActionPatch({ nextActionAt: null }, { nextActionNote: 'call', nextActionTime: '10:00' }), {
    nextActionNote: 'call',
    nextActionTime: null,
  });
  // Due and overdue read the day only, so a late time on the due day is still due, not later.
  assert.equal(isNextActionReminderDue({ nextActionAt: day('2026-03-12'), nextActionRemindedAt: null }, NOW), true);
});

test('follow-ups order by day, then untimed before timed, then by time; no day last', () => {
  const rows = [
    { id: 'none', at: null, time: null },
    { id: 'd2-0900', at: '2026-03-13T00:00:00.000Z', time: '09:00' },
    { id: 'd1-1500', at: '2026-03-12T00:00:00.000Z', time: '15:00' },
    { id: 'd1-whole', at: '2026-03-12T00:00:00.000Z', time: null },
    { id: 'd1-0830', at: day('2026-03-12'), time: '08:30' },
  ];
  assert.deepEqual(
    [...rows].sort(compareNextActions).map((r) => r.id),
    ['d1-whole', 'd1-0830', 'd1-1500', 'd2-0900', 'none'],
  );
});
