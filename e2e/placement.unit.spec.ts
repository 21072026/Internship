import { test, expect } from '@playwright/test';
import { countsAsPlacement, isOurHire, isPlacementRelation } from '@/lib/placement';

// #1504 — the one rule every placement count reads. Browserless.

const finished = ['HIRED_660', 'EMPLOYED_700'];
const rel = (over: { kind?: string | null; employmentAttribution?: string | null; pipelineStatus?: string }) => ({ pipelineStatus: 'HIRED_660', ...over });

test('a placement is a PLACEMENT relation, on a finished stage, whose hire is ours', { tag: '@smoke' }, async () => {
  // Coaching never counts, whatever its stage.
  expect(countsAsPlacement(rel({ kind: 'COACHING' }), finished)).toBe(false);
  // Honest outcomes that are not ours.
  expect(countsAsPlacement(rel({ kind: 'PLACEMENT', employmentAttribution: 'SELF_FOUND' }), finished)).toBe(false);
  expect(countsAsPlacement(rel({ kind: 'PLACEMENT', employmentAttribution: 'ALREADY_EMPLOYED' }), finished)).toBe(false);
  // Ours: stated, or not stated at all (every row from before #1503).
  expect(countsAsPlacement(rel({ kind: 'PLACEMENT', employmentAttribution: 'THROUGH_US' }), finished)).toBe(true);
  expect(countsAsPlacement(rel({ kind: 'PLACEMENT', employmentAttribution: null }), finished)).toBe(true);
  expect(countsAsPlacement(rel({}), new Set(finished))).toBe(true);
  // Not on a finished stage of THIS tenant.
  expect(countsAsPlacement(rel({ pipelineStatus: 'APPLICATION_100' }), finished)).toBe(false);
  expect(countsAsPlacement(rel({ pipelineStatus: 'HIRED_660' }), ['OFFER_SIGNED'])).toBe(false);

  expect(isPlacementRelation(null)).toBe(true);
  expect(isPlacementRelation('COACHING')).toBe(false);
  expect(isOurHire(undefined)).toBe(true);
  expect(isOurHire('SELF_FOUND')).toBe(false);
});
