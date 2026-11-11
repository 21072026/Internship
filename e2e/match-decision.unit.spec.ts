// Unit tests for the pairing audit record's pure rules (#1789). Pure node.
//
// Guarded: "overrode the ranking" is decided from the batch the SERVER
// recorded, and only when there was a ranking to overrule; the stored score
// is a deep copy no later mutation can reach.
import { test, expect } from '@playwright/test';
import { frozenScore, rankingOutcome } from '@/lib/matching/decisionRule';

test('no batch shown: no rank, no override', { tag: '@smoke' }, () => {
  expect(rankingOutcome([], 'm1')).toEqual({ suggestedRank: null, overrodeSuggestion: false });
});

test('the top suggestion chosen is not an override', { tag: '@smoke' }, () => {
  const shown = [{ mentorId: 'm1', rank: 1 }, { mentorId: 'm2', rank: 2 }];
  expect(rankingOutcome(shown, 'm1')).toEqual({ suggestedRank: 1, overrodeSuggestion: false });
});

test('a lower suggestion, or somebody off the list, is an override', { tag: '@smoke' }, () => {
  const shown = [{ mentorId: 'm1', rank: 1 }, { mentorId: 'm2', rank: 2 }, { mentorId: 'x', rank: null }];
  expect(rankingOutcome(shown, 'm2')).toEqual({ suggestedRank: 2, overrodeSuggestion: true });
  expect(rankingOutcome(shown, 'm9')).toEqual({ suggestedRank: null, overrodeSuggestion: true });
});

test('the frozen copy is detached from what the caller holds', { tag: '@smoke' }, () => {
  const match = { score: 66.6, blockedBy: [] as string[], breakdown: [{ dimension: 'skills', kind: 'WEIGHTED' as const, weight: 100, ratio: 0.666, contribution: 66.6, passed: true, detail: ['React'] }] };
  const frozen = frozenScore(match);
  match.breakdown[0].detail.push('changed');
  match.breakdown[0].contribution = 1;
  expect(frozen.score).toBe(67);
  expect(frozen.breakdown[0].detail).toEqual(['React']);
  expect(frozen.breakdown[0].contribution).toBe(66.6);
});
