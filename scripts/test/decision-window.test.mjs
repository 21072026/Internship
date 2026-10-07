// Unit tests for the decision window in src/lib/trialReminderRule.ts (#2843,
// decision #2572 Q2): it closes trialEndsAt + 30 days; its owner is warned a
// week before, and the bell's claim can never collide with the trial ladder.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_WINDOW_CLAIM,
  DECISION_WINDOW_DAYS,
  DECISION_WINDOW_WARN_DAYS,
  TRIAL_REMINDER_THRESHOLDS,
  decisionWindowEndsAt,
  isDecisionWindowClosing,
} from '../../src/lib/trialReminderRule.ts';

const d = (s) => new Date(`${s}T00:00:00Z`);

test('the window closes 30 days after the free period ends', () => {
  assert.equal(DECISION_WINDOW_DAYS, 30);
  assert.equal(decisionWindowEndsAt(d('2026-10-01')).toISOString(), '2026-10-31T00:00:00.000Z');
  assert.equal(decisionWindowEndsAt('2026-10-01T00:00:00.000Z').toISOString(), '2026-10-31T00:00:00.000Z');
  assert.equal(decisionWindowEndsAt(null), null);
});

test('closing = an expired trial within a week of the end, or past it', () => {
  const rec = { pipelineStatus: 'TRIAL_EXPIRED', trialEndsAt: d('2026-10-01') };
  assert.equal(isDecisionWindowClosing(rec, d('2026-10-23')), false); // 8 days left
  assert.equal(isDecisionWindowClosing(rec, d('2026-10-24')), true); // 7 days left
  assert.equal(isDecisionWindowClosing(rec, d('2026-11-05')), true); // closed, nobody decided
  assert.equal(isDecisionWindowClosing({ ...rec, pipelineStatus: 'TRIAL_ACTIVE' }, d('2026-10-30')), false);
  assert.equal(isDecisionWindowClosing({ ...rec, trialEndsAt: null }, d('2026-10-30')), false);
});

test('the claim threshold is negative and outside the trial ladder', () => {
  assert.equal(DECISION_WINDOW_CLAIM, -(DECISION_WINDOW_DAYS - DECISION_WINDOW_WARN_DAYS));
  assert.ok(DECISION_WINDOW_CLAIM < 0);
  assert.ok(!TRIAL_REMINDER_THRESHOLDS.includes(DECISION_WINDOW_CLAIM));
});
