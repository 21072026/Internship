// Accepted offer → hired stage (#2658) — the pure decision. No Next, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOfferAutoAdvance } from '../../src/lib/offerAutoAdvanceRule.ts';

const HIRED = 'HIRED_660';
const DEFAULT = [
  { key: 'APPLICATION_100', order: 100, isOffPath: false },
  { key: 'HIREABLE_600', order: 600, isOffPath: false },
  { key: 'HIRED_660', order: 660, isOffPath: false },
  { key: 'EMPLOYED_700', order: 700, isOffPath: false },
  { key: 'INTERNSHIP_DROPPED_460', order: 460, isOffPath: true },
];
const base = { enabled: true, hiredKey: HIRED, stages: DEFAULT, currentStage: 'HIREABLE_600', relationStatus: 'ACTIVE' };

test('on, active, before the hired stage: moves to it', () => {
  assert.deepEqual(decideOfferAutoAdvance(base), { move: true, to: HIRED });
  assert.deepEqual(decideOfferAutoAdvance({ ...base, currentStage: 'APPLICATION_100' }), { move: true, to: HIRED });
});

test('off is exactly the old behaviour: nothing moves', () => {
  assert.deepEqual(decideOfferAutoAdvance({ ...base, enabled: false }), { move: false, reason: 'disabled' });
});

test('a pipeline without the hired stage is a skip, never an invented stage', () => {
  const custom = [{ key: 'SOURCED', order: 1, isOffPath: false }, { key: 'PLACED', order: 2, isOffPath: false }];
  assert.deepEqual(decideOfferAutoAdvance({ ...base, stages: custom, currentStage: 'SOURCED' }), {
    move: false,
    reason: 'no_hired_stage',
  });
});

test('never backwards: at or past the hired stage stays put', () => {
  assert.equal(decideOfferAutoAdvance({ ...base, currentStage: HIRED }).move, false);
  assert.equal(decideOfferAutoAdvance({ ...base, currentStage: 'EMPLOYED_700' }).move, false);
});

test('an off-path stage is not "past" hired: the acceptance moves it', () => {
  assert.deepEqual(decideOfferAutoAdvance({ ...base, currentStage: 'INTERNSHIP_DROPPED_460' }), { move: true, to: HIRED });
});

test('a completed relation is history and is not rewritten', () => {
  assert.deepEqual(decideOfferAutoAdvance({ ...base, relationStatus: 'COMPLETED' }), { move: false, reason: 'not_active' });
});

test('a stage key the pipeline no longer knows moves forward (it cannot be proven past hired)', () => {
  assert.deepEqual(decideOfferAutoAdvance({ ...base, currentStage: 'RETIRED_KEY' }), { move: true, to: HIRED });
});
