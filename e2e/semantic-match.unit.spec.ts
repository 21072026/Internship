// Unit tests for the semantic match rule (#2038). Pure node — no browser, no DB.
//
// Guarded: the comparison is deterministic arithmetic over cached themes
// (exact = 1, a shared significant word = ½, over the mentee's themes); a
// person without a digest leaves the rule not applicable, so nobody's order
// moves; weight 0 reproduces the ranking without the rule exactly; a mentor
// with no literal skill overlap can rank first on shared themes, with the
// themes named; and the rule can never block — the schema refuses a hard
// kind and the scorer reads one found anyway as weighted.
import { test, expect } from '@playwright/test';
import { normalizeThemes, semanticAffinity } from '@/lib/matching/semantic';
import { rankMatches, scoreMatch, type MatchRuleSetInput } from '@/lib/matching/score';
import { matchRuleSchema } from '@/lib/matching/ruleSetSchema';

const now = new Date('2026-10-30T12:00:00Z');
const ruleSet = (semanticWeight: number | null): MatchRuleSetInput => ({
  id: 'rs',
  name: 'Test',
  version: 1,
  rules: [
    { dimension: 'skills', kind: 'WEIGHTED', weight: 70, config: { mode: 'lowercase' } },
    ...(semanticWeight === null ? [] : [{ dimension: 'semanticAffinity', kind: 'WEIGHTED' as const, weight: semanticWeight, config: {} }]),
  ],
});
const mentee = { id: 'me', skills: ['Testing'], themes: ['backend engineering', 'go', 'career switch'] };
const mentors = [
  { id: 'literal', activeMenteeCount: 0, skills: ['Testing'], themes: ['quality assurance'] },
  { id: 'semantic', activeMenteeCount: 0, skills: ['Kubernetes'], themes: ['go', 'career switch', 'platform engineering'] },
  { id: 'none', activeMenteeCount: 0, skills: ['Figma'] },
];

test('themes are normalised, de-duplicated and bounded', { tag: '@smoke' }, () => {
  expect(normalizeThemes(['  Platform-Engineering ', 'platform engineering', 'C++', 42, null])).toEqual(['platform engineering', 'c++']);
  expect(normalizeThemes(Array.from({ length: 40 }, (_, i) => `theme ${i}`))).toHaveLength(20);
  expect(normalizeThemes('not a list')).toEqual([]);
});

test('affinity: exact themes count 1, a shared significant word counts ½', { tag: '@smoke' }, () => {
  const a = semanticAffinity(['backend engineering', 'go', 'career switch'], ['go', 'platform engineering', 'career switch']);
  expect(a.sharedThemes).toEqual(['go', 'career switch']);
  expect(a.relatedThemes).toEqual([{ theme: 'backend engineering', via: 'platform engineering' }]);
  expect(a.score).toBeCloseTo((1 + 1 + 0.5) / 3, 3);
  // Filler and short words never make a match.
  expect(semanticAffinity(['work with data'], ['work with people']).score).toBe(0);
  // Order of the mentor's list does not change who "met halfway".
  expect(semanticAffinity(['data platform'], ['platform team', 'data science']).relatedThemes)
    .toEqual(semanticAffinity(['data platform'], ['data science', 'platform team']).relatedThemes);
});

test('no digest on either side: not applicable, the same 0 for everybody', { tag: '@smoke' }, () => {
  const bare = { id: 'me', skills: ['Testing'] };
  const withRule = rankMatches(bare, mentors, ruleSet(30), { now }).map((r) => r.mentor.id);
  const without = rankMatches(bare, mentors, ruleSet(null), { now }).map((r) => r.mentor.id);
  expect(withRule).toEqual(without);
  const row = scoreMatch(bare, mentors[1], ruleSet(30), { now }).breakdown.find((e) => e.dimension === 'semanticAffinity');
  expect(row).toMatchObject({ contribution: 0, detail: ['no profile digest'] });
});

test('weight 0 reproduces the ranking without the rule exactly', { tag: '@smoke' }, () => {
  const off = rankMatches(mentee, mentors, ruleSet(0), { now }).map((r) => [r.mentor.id, r.match.score]);
  const none = rankMatches(mentee, mentors, ruleSet(null), { now }).map((r) => [r.mentor.id, r.match.score]);
  expect(off).toEqual(none);
  expect(none[0][0]).toBe('literal');
});

test('a mentor with no literal overlap can rank first, the themes named', { tag: '@smoke' }, () => {
  const ranked = rankMatches(mentee, mentors, ruleSet(100), { now });
  expect(ranked[0].mentor.id).toBe('semantic');
  const row = ranked[0].match.breakdown.find((e) => e.dimension === 'semanticAffinity')!;
  expect(row.detail).toEqual(['go', 'career switch', 'backend engineering ≈ platform engineering']);
  expect(row.contribution).toBeGreaterThan(0);
});

test('the rule never blocks: a hard kind is refused on write and read as weighted', { tag: '@smoke' }, () => {
  expect(matchRuleSchema.safeParse({ dimension: 'semanticAffinity', kind: 'HARD_REQUIRE', weight: 0, config: {} }).success).toBe(false);
  expect(matchRuleSchema.safeParse({ dimension: 'semanticAffinity', kind: 'WEIGHTED', weight: 25, config: {} }).success).toBe(true);
  const stray: MatchRuleSetInput = { id: 'x', name: 'x', version: 1, rules: [{ dimension: 'semanticAffinity', kind: 'HARD_REQUIRE', weight: 0, config: {} }] };
  expect(scoreMatch(mentee, mentors[2], stray, { now }).blockedBy).toEqual([]);
});
