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
  nextActionPatch,
  parseNextActionDate,
  parseNextActionNote,
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
  assert.deepEqual(nextActionPatch(current, { nextActionAt: null }), { nextActionAt: null, nextActionRemindedAt: null });
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
