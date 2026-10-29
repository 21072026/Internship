// Unit tests for the bulk matching round lifecycle (#1793). Pure node.
//
// Guarded: PUBLISHED and DISCARDED are terminal; only the publish path can
// publish a round or a proposal; an admin's edit can move a round DRAFT ⇄
// REVIEW and a proposal DRAFT ⇄ LOCKED, discard either, and un-discard a proposal.
import { test, expect } from '@playwright/test';
import { canTransitionProposal, canTransitionRound, isRoundEditable, ROUND_STATUSES, PROPOSAL_STATES } from '@/lib/matching/round';

test('a published or discarded round goes nowhere, for anybody', { tag: '@smoke' }, () => {
  for (const to of ROUND_STATUSES) {
    for (const actor of ['admin', 'publish'] as const) {
      expect(canTransitionRound('PUBLISHED', to, actor)).toBe(false);
      expect(canTransitionRound('DISCARDED', to, actor)).toBe(false);
    }
  }
  expect(isRoundEditable('PUBLISHED')).toBe(false);
  expect(isRoundEditable('DISCARDED')).toBe(false);
});

test('only the publish path publishes, and only from REVIEW', { tag: '@smoke' }, () => {
  expect(canTransitionRound('REVIEW', 'PUBLISHED', 'admin')).toBe(false);
  expect(canTransitionRound('REVIEW', 'PUBLISHED', 'publish')).toBe(true);
  expect(canTransitionRound('DRAFT', 'PUBLISHED', 'publish')).toBe(false);
});

test('an admin moves a round DRAFT ⇄ REVIEW and discards it until published', { tag: '@smoke' }, () => {
  expect(canTransitionRound('DRAFT', 'REVIEW')).toBe(true);
  expect(canTransitionRound('REVIEW', 'DRAFT')).toBe(true);
  expect(canTransitionRound('DRAFT', 'DISCARDED')).toBe(true);
  expect(canTransitionRound('REVIEW', 'DISCARDED')).toBe(true);
});

test('proposals: lock, unlock, discard, restore; publish only when locked, only by publish', { tag: '@smoke' }, () => {
  expect(canTransitionProposal('DRAFT', 'LOCKED')).toBe(true);
  expect(canTransitionProposal('LOCKED', 'DRAFT')).toBe(true);
  expect(canTransitionProposal('LOCKED', 'DISCARDED')).toBe(true);
  expect(canTransitionProposal('DISCARDED', 'DRAFT')).toBe(true);
  expect(canTransitionProposal('DRAFT', 'PUBLISHED', 'publish')).toBe(false);
  expect(canTransitionProposal('LOCKED', 'PUBLISHED', 'admin')).toBe(false);
  expect(canTransitionProposal('LOCKED', 'PUBLISHED', 'publish')).toBe(true);
  for (const to of PROPOSAL_STATES) expect(canTransitionProposal('PUBLISHED', to, 'publish')).toBe(false);
});
