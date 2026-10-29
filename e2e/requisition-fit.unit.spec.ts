import { test, expect } from '@playwright/test';
import { REQUISITION_FIT_RULESET_VERSION, REQUISITION_FIT_WEIGHTS, scoreFit, stageProgressOf, type FitCandidate } from '@/lib/matching/requisitionFit';
import { rankRequisitionMatches } from '@/lib/requisitionMatchRule';
import type { SkillEdgeRow } from '@/lib/skillTaxonomyRule';

// #2042 — the requisition fit score: deterministic, explainable, and fed only
// job-related facts. Browserless.

const edges: SkillEdgeRow[] = [{ fromSkillId: 'react', toSkillId: 'vue', weight: 0.8, kind: 'ADJACENT' }];
const role = { title: 'Frontend Developer', requiredSkillIds: ['react', 'ts'], niceSkillIds: ['css'], city: 'Berlin', workMode: 'ONSITE' };
const cand = (over: Partial<FitCandidate> = {}): FitCandidate => ({
  id: 'c', targetPosition: 'Frontend Developer', skillIds: ['react', 'ts', 'css'], city: 'Berlin', stageProgress: 1, ...over,
});

test('a perfect candidate scores 100 and the contributions sum to the score', { tag: '@smoke' }, async () => {
  const f = scoreFit(role, cand(), edges);
  expect(f.score).toBe(100);
  expect(f.ruleSetVersion).toBe(REQUISITION_FIT_RULESET_VERSION);
  expect(f.breakdown.map((b) => b.dimension).sort()).toEqual(Object.keys(REQUISITION_FIT_WEIGHTS).sort());
  expect(Math.round(f.breakdown.reduce((s, b) => s + b.contribution, 0))).toBe(100);
});

test('required skills weigh more than nice-to-have, and adjacency counts partly', { tag: '@smoke' }, async () => {
  const missingNice = scoreFit(role, cand({ skillIds: ['react', 'ts'] }), edges).score;
  const missingRequired = scoreFit(role, cand({ skillIds: ['react', 'css'] }), edges).score;
  expect(missingNice).toBeGreaterThan(missingRequired);
  const related = scoreFit(role, cand({ skillIds: ['vue', 'ts', 'css'] }), edges).score;
  expect(related).toBeLessThan(100);
  expect(related).toBeGreaterThan(missingRequired);
});

test('a dimension with nothing to compare is not applicable — neither penalty nor bonus', { tag: '@smoke' }, async () => {
  const noCity = { ...role, city: null, workMode: null };
  const f = scoreFit(noCity, cand({ city: 'Hamburg' }), edges);
  expect(f.score).toBe(100);
  expect(f.breakdown.find((b) => b.dimension === 'location')).toMatchObject({ weight: 0, contribution: 0 });
  // Remote makes the city irrelevant.
  expect(scoreFit({ ...role, workMode: 'REMOTE' }, cand({ city: 'Hamburg' }), edges).score).toBe(100);
  // No stage, no target position: still scored on what exists.
  expect(scoreFit(role, cand({ stageProgress: null, targetPosition: null }), edges).score).toBe(100);
});

test('stage progress comes from the on-path order, never from a named key', { tag: '@smoke' }, async () => {
  const stages = [{ key: 'a' }, { key: 'x', isOffPath: true }, { key: 'b' }, { key: 'c' }];
  expect(stageProgressOf('a', stages)).toBe(0);
  expect(stageProgressOf('c', stages)).toBe(1);
  expect(stageProgressOf('x', stages)).toBeNull();
  expect(stageProgressOf(null, stages)).toBeNull();
});

test('the score reads only job-related fields — no protected characteristic can be an input', { tag: '@smoke' }, async () => {
  // Adding fields the type does not list changes nothing: the score cannot see them.
  const plain = scoreFit(role, cand(), edges);
  const withExtras = scoreFit(role, { ...cand(), ...({ gender: 'x', birthDate: '1990-01-01', nationality: 'y', fullName: 'Z', photoUrl: 'p' } as object) } as FitCandidate, edges);
  expect(withExtras).toEqual(plain);
});

test('the matcher orders by fit and never drops a match for a low score', { tag: '@smoke' }, async () => {
  const req = { title: 'Frontend Developer', requiredSkillIds: ['react', 'ts'], city: 'Berlin' };
  const ranked = rankRequisitionMatches(
    req,
    [
      { id: 'far', targetPosition: null, skillIds: ['react', 'ts'], city: 'Munich', stageProgress: 0 },
      { id: 'near', targetPosition: 'Frontend Developer', skillIds: ['react', 'ts'], city: 'Berlin', stageProgress: 1 },
    ],
    edges,
  );
  expect(ranked.map((m) => m.candidateId)).toEqual(['near', 'far']);
  expect(ranked[1].fit.score).toBeLessThan(ranked[0].fit.score);
});
