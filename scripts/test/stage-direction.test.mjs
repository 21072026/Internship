// Unit tests for the machine no-regression rule (#2451).
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBackwardMove } from '../../src/lib/stageDirection.ts';

// The MARKETING_FUNNEL preset's shape as an org provisioned before #2840 keeps
// it — the two retired deal stages included, which is the harder case.
const STAGES = [
  { key: 'LEAD_NEW', order: 0, isOffPath: false },
  { key: 'LEAD_CONTACTED', order: 1, isOffPath: false },
  { key: 'LEAD_QUALIFIED', order: 2, isOffPath: false },
  { key: 'TRIAL_ACTIVE', order: 3, isOffPath: false },
  { key: 'TRIAL_EXPIRED', order: 4, isOffPath: false },
  { key: 'DEAL_PROPOSAL', order: 5, isOffPath: false },
  { key: 'DEAL_NEGOTIATION', order: 6, isOffPath: false },
  { key: 'DEAL_WON', order: 7, isOffPath: false },
  { key: 'DEAL_LOST', order: 8, isOffPath: true },
];

test('forward along the path is not backward', () => {
  assert.equal(isBackwardMove(STAGES, 'LEAD_NEW', 'TRIAL_ACTIVE'), false);
  assert.equal(isBackwardMove(STAGES, 'TRIAL_ACTIVE', 'DEAL_WON'), false);
});

test('a won deal is never dragged back to the trial', () => {
  assert.equal(isBackwardMove(STAGES, 'DEAL_WON', 'TRIAL_ACTIVE'), true);
  assert.equal(isBackwardMove(STAGES, 'TRIAL_EXPIRED', 'TRIAL_ACTIVE'), true);
});

test('an exit to an off-path stage is allowed from anywhere', () => {
  assert.equal(isBackwardMove(STAGES, 'DEAL_WON', 'DEAL_LOST'), false);
  assert.equal(isBackwardMove(STAGES, 'LEAD_NEW', 'DEAL_LOST'), false);
});

test('a lost record is never reopened by a machine — order does not save it', () => {
  // DEAL_LOST has the HIGHEST order: a plain order comparison would call this forward.
  assert.equal(isBackwardMove(STAGES, 'DEAL_LOST', 'TRIAL_ACTIVE'), true);
  assert.equal(isBackwardMove(STAGES, 'DEAL_LOST', 'DEAL_WON'), true);
});

test('the same stage, or a stage the org does not have, is not a backward move', () => {
  assert.equal(isBackwardMove(STAGES, 'TRIAL_ACTIVE', 'TRIAL_ACTIVE'), false);
  assert.equal(isBackwardMove(STAGES, 'NOPE', 'TRIAL_ACTIVE'), false);
  assert.equal(isBackwardMove(STAGES, 'DEAL_WON', 'NOPE'), false);
});
