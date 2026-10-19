// Unit tests for the decision window in src/lib/trialReminderRule.ts (#2843,
// #2927): it closes trialEndsAt + the org's `decisionWindowDays` (30 by
// default); its owner is warned a week before, and the bell's claim can never
// collide with the trial ladder.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_WINDOW_CLAIM,
  DECISION_WINDOW_WARN_DAYS,
  DEFAULT_DECISION_WINDOW_DAYS,
  MAX_DECISION_WINDOW_DAYS,
  TRIAL_REMINDER_THRESHOLDS,
  decisionWindowEndsAt,
  isDecisionWindowClosing,
  isDecisionWindowBellDue,
  DECISION_WINDOW_STALE_DAYS,
  parseDecisionWindowDays,
} from '../../src/lib/trialReminderRule.ts';

const d = (s) => new Date(`${s}T00:00:00Z`);

test('by default the window closes 30 days after the free period ends', () => {
  assert.equal(DEFAULT_DECISION_WINDOW_DAYS, 30);
  assert.equal(decisionWindowEndsAt(d('2026-10-01')).toISOString(), '2026-10-31T00:00:00.000Z');
  assert.equal(decisionWindowEndsAt('2026-10-01T00:00:00.000Z').toISOString(), '2026-10-31T00:00:00.000Z');
  assert.equal(decisionWindowEndsAt(null), null);
});

test("an organization's own window length moves the end", () => {
  assert.equal(decisionWindowEndsAt(d('2026-10-01'), 14).toISOString(), '2026-10-15T00:00:00.000Z');
  assert.equal(decisionWindowEndsAt(d('2026-10-01'), 60).toISOString(), '2026-11-30T00:00:00.000Z');
});

test('closing = an expired trial within a week of the end, or past it', () => {
  const rec = { pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: d('2026-10-01') };
  assert.equal(isDecisionWindowClosing(rec, d('2026-10-23')), false); // 8 days left
  assert.equal(isDecisionWindowClosing(rec, d('2026-10-24')), true); // 7 days left
  assert.equal(isDecisionWindowClosing(rec, d('2026-11-05')), true); // closed, nobody decided
  assert.equal(isDecisionWindowClosing({ ...rec, pipelineStatus: 'TRIAL_ACTIVE' }, d('2026-10-30')), false);
  assert.equal(isDecisionWindowClosing({ ...rec, trialEndsAt: null }, d('2026-10-30')), false);
  // A 14-day window: warned from the 7th day after the trial end on.
  assert.equal(isDecisionWindowClosing(rec, d('2026-10-07'), 14), false); // 8 days left
  assert.equal(isDecisionWindowClosing(rec, d('2026-10-08'), 14), true); // 7 days left
  // A window shorter than the warning is closing from its first day.
  assert.equal(isDecisionWindowClosing(rec, d('2026-10-01'), 3), true);
});

test('the decisionWindowDays setting parses whole days in 1..365, anything else is 30', () => {
  assert.equal(MAX_DECISION_WINDOW_DAYS, 365);
  for (const [raw, days] of [
    ['30', 30],
    ['14', 14],
    [' 60 ', 60],
    ['1', 1],
    ['365', 365],
    ['366', 30],
    ['0', 30],
    ['', 30],
    [null, 30],
    [undefined, 30],
    ['-5', 30],
    ['7.5', 30],
    ['ten', 30],
    ['12345', 30],
  ]) {
    assert.equal(parseDecisionWindowDays(raw), days, String(raw));
  }
});

test('the claim threshold is a fixed negative marker outside the trial ladder', () => {
  // Fixed at the value it had when the window was a 30-day constant, so the
  // claims written then still count now that the length is per organization.
  assert.equal(DECISION_WINDOW_CLAIM, -(DEFAULT_DECISION_WINDOW_DAYS - DECISION_WINDOW_WARN_DAYS));
  assert.equal(DECISION_WINDOW_CLAIM, -23);
  assert.ok(!TRIAL_REMINDER_THRESHOLDS.includes(DECISION_WINDOW_CLAIM));
});

test('the bell never rings for a window that closed more than a week ago (#2970)', () => {
  assert.equal(DECISION_WINDOW_STALE_DAYS, 7);
  // Window: 2026-10-01 + 30 days = closes 2026-10-31.
  const rec = { pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: d('2026-10-01') };
  assert.equal(isDecisionWindowBellDue(rec, d('2026-10-23')), false); // 8 days left: not yet
  assert.equal(isDecisionWindowBellDue(rec, d('2026-10-24')), true); // 7 days left
  assert.equal(isDecisionWindowBellDue(rec, d('2026-10-31')), true); // closes today
  assert.equal(isDecisionWindowBellDue(rec, d('2026-11-07')), true); // closed 7 days ago: still a missed sweep
  assert.equal(isDecisionWindowBellDue(rec, d('2026-11-08')), false); // closed 8 days ago: stale
  assert.equal(isDecisionWindowBellDue(rec, d('2027-03-01')), false); // a historic record
  // The queue still shows it — only the bell is quiet.
  assert.equal(isDecisionWindowClosing(rec, d('2027-03-01')), true);
  // The org's own window length moves both edges.
  assert.equal(isDecisionWindowBellDue(rec, d('2026-10-22'), 14), true); // closed 2026-10-15, 7 days ago
  assert.equal(isDecisionWindowBellDue(rec, d('2026-10-23'), 14), false);
  assert.equal(isDecisionWindowBellDue({ ...rec, pipelineStatus: 'TRIAL_ACTIVE' }, d('2026-10-30')), false);
  assert.equal(isDecisionWindowBellDue({ ...rec, trialEndsAt: null }, d('2026-10-30')), false);
});
