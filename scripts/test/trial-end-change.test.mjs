// Unit tests for the hand-set trial end (#2553, story #2392).
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
//
// Two rules, both in the dependency-free src/lib/trialReminderRule.ts:
//
//   * isTrialMissingEndDate() — a record in TRIAL_ACTIVE with no end date is
//     reminded about by nothing and expired by nothing, so it must surface as
//     the `trial_no_end_date` attention reason and a "date missing" badge until
//     somebody enters the date;
//   * planTrialEndChange() — what PATCH /api/mentorship/[id]/trial may write:
//     only in a trial stage, never a past day, a same-day edit is a no-op, and
//     a TRIAL_EXPIRED record extended into the future goes back to TRIAL_ACTIVE.
//
// Plus the claim-row property the extension relies on: the ladder skips a
// claimed threshold in the NEW window, and fires one that was never claimed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TRIAL_ACTIVE_STAGE_KEY,
  TRIAL_EXPIRED_STAGE_KEY,
  isTrialEndEditableStage,
  isTrialMissingEndDate,
  parseTrialEndDate,
  planTrialEndChange,
  selectDueTrialReminders,
} from '../../src/lib/trialReminderRule.ts';

const NOW = new Date('2026-03-10T22:30:00.000Z');
const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

// ── The undated trial ────────────────────────────────────────────────────────

test('a running trial with no end date is flagged', () => {
  assert.equal(isTrialMissingEndDate({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, trialEndsAt: null }), true);
  assert.equal(isTrialMissingEndDate({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, trialEndsAt: undefined }), true);
  assert.equal(isTrialMissingEndDate({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, trialEndsAt: '' }), true);
  // An unparseable value is no date either — the ladder could not use it.
  assert.equal(isTrialMissingEndDate({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, trialEndsAt: 'not a date' }), true);
});

test('the flag drops the moment a date is entered (Date or JSON string)', () => {
  assert.equal(isTrialMissingEndDate({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, trialEndsAt: day('2026-04-01') }), false);
  assert.equal(
    isTrialMissingEndDate({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, trialEndsAt: '2026-04-01T00:00:00.000Z' }),
    false,
  );
});

test('only the running-trial stage is flagged — an undated record elsewhere has no trial', () => {
  assert.equal(isTrialMissingEndDate({ pipelineStatus: TRIAL_EXPIRED_STAGE_KEY, trialEndsAt: null }), false);
  assert.equal(isTrialMissingEndDate({ pipelineStatus: 'APPLICATION_100', trialEndsAt: null }), false);
  assert.equal(isTrialMissingEndDate({ pipelineStatus: null, trialEndsAt: null }), false);
});

test('the attention queue reads the same predicate for `trial_no_end_date`', () => {
  // mentorAttention.ts imports Prisma and cannot be loaded here; pin the wiring
  // instead, so the queue and the badge cannot grow two definitions.
  const source = readFileSync(fileURLToPath(new URL('../../src/lib/mentorAttention.ts', import.meta.url)), 'utf8');
  assert.match(source, /'trial_no_end_date'/);
  assert.match(source, /if \(isTrialMissingEndDate\(r\)\) reasons\.push\('trial_no_end_date'\)/);
  assert.match(source, /trialEndsAt: true/);
});

// ── Parsing the typed day ────────────────────────────────────────────────────

test('parseTrialEndDate takes a real YYYY-MM-DD day as midnight UTC', () => {
  assert.equal(parseTrialEndDate('2026-04-01')?.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(parseTrialEndDate(' 2026-04-01 ')?.toISOString(), '2026-04-01T00:00:00.000Z');
  for (const bad of ['2026-02-30', '2026-13-01', '01.04.2026', '2026-04-01T10:00:00Z', '', null, 20260401, '1999-01-01']) {
    assert.equal(parseTrialEndDate(bad), null, String(bad));
  }
});

// ── planTrialEndChange ───────────────────────────────────────────────────────

test('extending a running trial writes the new day and keeps the stage', () => {
  const plan = planTrialEndChange({
    pipelineStatus: TRIAL_ACTIVE_STAGE_KEY,
    currentEndsAt: day('2026-03-13'),
    newEndsAt: day('2026-04-10'),
    now: NOW,
  });
  assert.deepEqual(plan, { ok: true, changed: true, trialEndsAt: day('2026-04-10'), reopen: false });
});

test('an undated running trial takes its first date', () => {
  const plan = planTrialEndChange({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, currentEndsAt: null, newEndsAt: day('2026-03-20'), now: NOW });
  assert.equal(plan.ok && plan.changed && plan.reopen, false);
  assert.equal(plan.ok && plan.changed && plan.trialEndsAt.toISOString(), '2026-03-20T00:00:00.000Z');
});

test('extending an expired trial reopens it', () => {
  const plan = planTrialEndChange({
    pipelineStatus: TRIAL_EXPIRED_STAGE_KEY,
    currentEndsAt: day('2026-03-08'),
    newEndsAt: day('2026-03-13'),
    now: NOW,
  });
  assert.equal(plan.ok && plan.changed && plan.reopen, true);
});

test('today counts as "today or later" by UTC day, whatever the hour', () => {
  const plan = planTrialEndChange({ pipelineStatus: TRIAL_EXPIRED_STAGE_KEY, currentEndsAt: day('2026-03-01'), newEndsAt: day('2026-03-10'), now: NOW });
  assert.equal(plan.ok && plan.changed, true);
});

test('a past day is refused', () => {
  assert.deepEqual(
    planTrialEndChange({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, currentEndsAt: null, newEndsAt: day('2026-03-09'), now: NOW }),
    { ok: false, error: 'in_the_past' },
  );
});

test('outside a trial stage the date is refused', () => {
  assert.equal(isTrialEndEditableStage('PROPOSAL'), false);
  assert.deepEqual(
    planTrialEndChange({ pipelineStatus: 'PROPOSAL', currentEndsAt: null, newEndsAt: day('2026-04-01'), now: NOW }),
    { ok: false, error: 'not_in_trial' },
  );
});

test('an invalid date is refused before anything else', () => {
  assert.deepEqual(
    planTrialEndChange({ pipelineStatus: 'PROPOSAL', currentEndsAt: null, newEndsAt: null, now: NOW }),
    { ok: false, error: 'invalid_date' },
  );
});

test('the same UTC day is a no-op even when the stored time differs', () => {
  assert.deepEqual(
    planTrialEndChange({
      pipelineStatus: TRIAL_ACTIVE_STAGE_KEY,
      currentEndsAt: new Date('2026-04-01T14:37:00.000Z'),
      newEndsAt: day('2026-04-01'),
      now: NOW,
    }),
    { ok: true, changed: false },
  );
});

test('shortening is a correction and is allowed', () => {
  const plan = planTrialEndChange({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, currentEndsAt: day('2026-05-01'), newEndsAt: day('2026-03-20'), now: NOW });
  assert.equal(plan.ok && plan.changed, true);
});

// ── The claim rows across an extension ───────────────────────────────────────

test('after an extension a claimed mark stays silent and an unclaimed one fires', () => {
  // 7 and 0 were claimed in the old window; the trial is extended to 3 days out.
  const extendedTo3 = [{ id: 'r', trialEndsAt: day('2026-03-13'), sentThresholds: [7, 0] }];
  assert.deepEqual(selectDueTrialReminders(extendedTo3, { now: NOW }), [
    { relationId: 'r', threshold: 3, daysRemaining: 3 },
  ]);
  // Extended to 7 days out instead: 7 was already mailed, so nothing goes out.
  const extendedTo7 = [{ id: 'r', trialEndsAt: day('2026-03-17'), sentThresholds: [7, 0] }];
  assert.deepEqual(selectDueTrialReminders(extendedTo7, { now: NOW }), []);
});
