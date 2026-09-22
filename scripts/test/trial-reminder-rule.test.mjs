// Unit tests for the trial reminder selector (#2413, story #2392).
//
// WHY THIS FILE EXISTS
//   The rule decides whether a merchant whose trial is running out hears from
//   us at all, and every way of getting it wrong is silent:
//
//     • comparing timestamps instead of calendar days drops the seven-day mail
//       for any trial that happens to end a few hours before the tick runs —
//       the bug the existing sweeps in this repo still have
//       (`expiresAt: { lt: now }`, `stageDeadline: { lt: now }`), and one you
//       cannot see in production because the mail that never went out leaves
//       nothing behind;
//     • reading the host's local day instead of the UTC one moves the boundary
//       by a timezone and makes the answer depend on where the container runs;
//     • firing on "at most N days left" rather than exactly N sends "your trial
//       ends in 7 days" on the day five days remain, and re-sends every missed
//       threshold at once after an outage.
//
//   None of that is reachable from a browser test — it is arithmetic about
//   dates — so it is pinned here, with fixed dates and an injected clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRIAL_REMINDER_THRESHOLDS,
  daysUntilUtcDay,
  selectDueTrialReminders,
  utcDayNumber,
} from '../../src/lib/trialReminderRule.ts';

// The tick. Deliberately late in the UTC day, because that is the arrangement
// that makes a naive timestamp comparison look right in the morning and wrong
// in the evening.
const NOW = new Date('2026-03-10T22:30:00.000Z');

const candidate = (id, endsAt, sentThresholds = []) => ({
  id,
  trialEndsAt: endsAt === null ? null : new Date(endsAt),
  sentThresholds,
});

test('the ladder is the three published marks, highest first', () => {
  assert.deepEqual([...TRIAL_REMINDER_THRESHOLDS], [7, 3, 0]);
});

test('a trial seven calendar days out is caught whatever hour the tick runs', () => {
  // Ends 2026-03-17. Seven calendar days from 2026-03-10 whether the trial ends
  // at one minute past midnight or one minute before it, and whether the tick
  // is at 00:05 or at 23:55.
  for (const endHour of ['00:00:01', '09:00:00', '23:59:59']) {
    for (const tickHour of ['00:05:00', '08:00:00', '22:30:00', '23:55:00']) {
      const due = selectDueTrialReminders([candidate('r1', `2026-03-17T${endHour}Z`)], {
        now: new Date(`2026-03-10T${tickHour}Z`),
      });
      assert.deepEqual(
        due,
        [{ relationId: 'r1', threshold: 7, daysRemaining: 7 }],
        `ends ${endHour}, tick ${tickHour}`,
      );
    }
  }
});

test('each mark fires on its own day, and on no other day', () => {
  // One trial ending 2026-03-17, walked day by day from a fortnight out.
  const endsAt = '2026-03-17T09:00:00.000Z';
  const fired = [];
  for (let day = 3; day <= 20; day++) {
    const now = new Date(Date.UTC(2026, 2, day, 6, 0, 0));
    const due = selectDueTrialReminders([candidate('r1', endsAt)], { now });
    for (const d of due) fired.push([day, d.threshold]);
  }
  assert.deepEqual(fired, [
    [10, 7], // 2026-03-10 → seven days out
    [14, 3], // 2026-03-14 → three days out
    [17, 0], // 2026-03-17 → the last day
  ]);
});

test('a threshold already claimed is not selected again', () => {
  const now = new Date('2026-03-10T06:00:00.000Z');
  const endsAt = '2026-03-17T09:00:00.000Z';
  assert.deepEqual(selectDueTrialReminders([candidate('r1', endsAt, [7])], { now }), []);
  // …and claiming a DIFFERENT mark does not suppress this one.
  assert.deepEqual(selectDueTrialReminders([candidate('r1', endsAt, [3, 0])], { now }), [
    { relationId: 'r1', threshold: 7, daysRemaining: 7 },
  ]);
});

test('an elapsed trial is never selected again — which is what makes old claims prunable', () => {
  for (const day of [18, 20, 40, 400]) {
    const now = new Date(Date.UTC(2026, 2, day, 6, 0, 0));
    assert.deepEqual(
      selectDueTrialReminders([candidate('r1', '2026-03-17T09:00:00.000Z')], { now }),
      [],
      `day ${day}`,
    );
  }
});

test('no trial date is "no trial", never "ends today"', () => {
  for (const missing of [null, undefined]) {
    const due = selectDueTrialReminders([{ id: 'r1', trialEndsAt: missing, sentThresholds: [] }], {
      now: NOW,
    });
    assert.deepEqual(due, []);
  }
  // An unparseable date is skipped rather than treated as the epoch.
  assert.deepEqual(
    selectDueTrialReminders([{ id: 'r1', trialEndsAt: new Date('nope'), sentThresholds: [] }], { now: NOW }),
    [],
  );
});

test('a month and a year boundary are still one calendar day apart', () => {
  // 2026-04-01 is seven days after 2026-03-25 …
  assert.deepEqual(
    selectDueTrialReminders([candidate('r1', '2026-04-01T04:00:00.000Z')], {
      now: new Date('2026-03-25T23:00:00.000Z'),
    }),
    [{ relationId: 'r1', threshold: 7, daysRemaining: 7 }],
  );
  // … and 2027-01-01 is three days after 2026-12-29, across the year.
  assert.deepEqual(
    selectDueTrialReminders([candidate('r2', '2027-01-01T00:30:00.000Z')], {
      now: new Date('2026-12-29T21:00:00.000Z'),
    }),
    [{ relationId: 'r2', threshold: 3, daysRemaining: 3 }],
  );
  // A leap day counts as a day like any other: 2028-02-29 → 2028-03-03 is 3.
  assert.equal(
    daysUntilUtcDay(new Date('2028-03-03T00:00:00.000Z'), new Date('2028-02-29T23:59:59.000Z')),
    3,
  );
});

test('one record can only be due for one mark on a tick, and a batch keeps input order', () => {
  const now = new Date('2026-03-10T12:00:00.000Z');
  const due = selectDueTrialReminders(
    [
      candidate('seven', '2026-03-17T08:00:00.000Z'),
      candidate('eight', '2026-03-18T08:00:00.000Z'), // between marks — nothing
      candidate('three', '2026-03-13T23:00:00.000Z'),
      candidate('today', '2026-03-10T01:00:00.000Z'), // last day, already past the hour
      candidate('gone', '2026-03-09T08:00:00.000Z'), // elapsed
      candidate('claimed', '2026-03-13T08:00:00.000Z', [3]),
    ],
    { now },
  );
  assert.deepEqual(due, [
    { relationId: 'seven', threshold: 7, daysRemaining: 7 },
    { relationId: 'three', threshold: 3, daysRemaining: 3 },
    { relationId: 'today', threshold: 0, daysRemaining: 0 },
  ]);
});

test('the last day fires even when the trial ended hours before the tick', () => {
  // The case a raw `trialEndsAt < now` sweep gets wrong in the other direction:
  // it would treat this as already expired and skip the final mail.
  const due = selectDueTrialReminders([candidate('r1', '2026-03-10T03:00:00.000Z')], {
    now: new Date('2026-03-10T22:30:00.000Z'),
  });
  assert.deepEqual(due, [{ relationId: 'r1', threshold: 0, daysRemaining: 0 }]);
});

test('the ladder can be overridden, de-duplicated and re-ordered without changing the answer', () => {
  const now = new Date('2026-03-10T06:00:00.000Z');
  const rows = [candidate('r1', '2026-03-11T06:00:00.000Z')];
  assert.deepEqual(selectDueTrialReminders(rows, { now, thresholds: [1, 1, 1] }), [
    { relationId: 'r1', threshold: 1, daysRemaining: 1 },
  ]);
  assert.deepEqual(selectDueTrialReminders(rows, { now, thresholds: [0, 1, 7] }), [
    { relationId: 'r1', threshold: 1, daysRemaining: 1 },
  ]);
  // A non-integer mark can never equal a whole-day difference; it is dropped
  // rather than silently rounded into one.
  assert.deepEqual(selectDueTrialReminders(rows, { now, thresholds: [1.5] }), []);
});

test('utcDayNumber reads the UTC day, not the host local one', () => {
  // 2026-03-10T23:30Z is 2026-03-11 in Istanbul and 2026-03-10 in New York;
  // both must answer with the UTC day, so two containers never disagree.
  const late = new Date('2026-03-10T23:30:00.000Z');
  const early = new Date('2026-03-10T00:30:00.000Z');
  assert.equal(utcDayNumber(late), utcDayNumber(early));
  assert.equal(utcDayNumber(new Date('2026-03-11T00:30:00.000Z')) - utcDayNumber(late), 1);
});

test('an empty batch is an empty answer, not a throw', () => {
  assert.deepEqual(selectDueTrialReminders([], { now: NOW }), []);
});
