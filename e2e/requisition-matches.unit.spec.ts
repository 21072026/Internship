import { test, expect } from '@playwright/test';
import { CONSENTING_POOL_WHERE, matchCandidate, rankRequisitionMatches, titleMatchesTarget } from '@/lib/requisitionMatchRule';
import type { SkillEdgeRow } from '@/lib/skillTaxonomyRule';

// The one "who fits this requisition" rule (#1401), shared by the admin's
// matching-candidates list and the premium match-alert cron.

const edges: SkillEdgeRow[] = [{ fromSkillId: 'react', toSkillId: 'vue', weight: 0.8, kind: 'ADJACENT' }];
const role = { title: 'Junior Frontend Developer', requiredSkillIds: ['react', 'ts', 'css'] };

test('a requisition with skills matches on canonical skills and says which ones', { tag: '@smoke' }, async () => {
  const m = matchCandidate(role, { id: 'a', targetPosition: null, skillIds: ['react', 'ts', 'go'] }, edges);
  expect(m).toMatchObject({ candidateId: 'a', via: 'skills', direct: ['react', 'ts'], adjacent: [] });
  // A related skill stands in for a missing required one, and is named as such.
  const related = matchCandidate(role, { id: 'b', targetPosition: null, skillIds: ['vue', 'ts'] }, edges);
  expect(related?.adjacent).toEqual([{ skillId: 'vue', via: 'react', weight: 0.8 }]);
  // One skill out of three is not a match, whatever the target position says.
  expect(matchCandidate(role, { id: 'c', targetPosition: 'Junior Frontend Developer', skillIds: ['css'] }, edges)).toBeNull();
});

test('a requisition without skills falls back to its title against the target position only', { tag: '@smoke' }, async () => {
  const bare = { title: 'Data Analyst', requiredSkillIds: [] };
  expect(matchCandidate(bare, { id: 'a', targetPosition: 'Junior Data Analyst', skillIds: [] }, [])).toMatchObject({ via: 'title' });
  // Skill strings are never compared with the title ("Go" vs. "...go..." titles).
  expect(matchCandidate({ title: 'Google Ads Manager', requiredSkillIds: [] }, { id: 'b', targetPosition: null, skillIds: ['go'] }, [])).toBeNull();
  expect(titleMatchesTarget('', 'Anything')).toBe(false);
  expect(titleMatchesTarget('Analyst', '')).toBe(false);
});

test('matches are ranked best first, stably, and capped', { tag: '@smoke' }, async () => {
  const candidates = [
    { id: 'z', targetPosition: null, skillIds: ['vue', 'ts'] },
    { id: 'y', targetPosition: null, skillIds: ['react', 'ts', 'css'] },
    { id: 'x', targetPosition: null, skillIds: ['react', 'ts'] },
    { id: 'w', targetPosition: null, skillIds: ['react', 'ts'] },
    { id: 'v', targetPosition: null, skillIds: [] },
  ];
  expect(rankRequisitionMatches(role, candidates, edges).map((m) => m.candidateId)).toEqual(['y', 'w', 'x', 'z']);
  expect(rankRequisitionMatches(role, candidates, edges, 2).map((m) => m.candidateId)).toEqual(['y', 'w']);
});

test('only the consenting talent pool is ever matched', { tag: '@smoke' }, async () => {
  expect(CONSENTING_POOL_WHERE).toEqual({
    role: 'MENTEE',
    isActive: true,
    publicProfile: true,
    consents: { some: { type: 'TALENT_POOL_VISIBILITY', grantedAt: { not: null }, revokedAt: null } },
  });
});
