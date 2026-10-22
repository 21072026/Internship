// Unit tests for the rule-set dry run and the weight preview (#1783). Pure
// node — no browser, no DB. The simulation must explain an over-tight rule set
// (which hard rule eliminated the most) instead of returning an empty list.
import { test, expect } from '@playwright/test';
import { normalizedWeights, simulateRuleSet } from '@/lib/matching/simulate';
import type { MatchRuleSetInput } from '@/lib/matching/score';

const NOW = { now: new Date('2026-10-20T12:00:00Z') };
const set = (rules: MatchRuleSetInput['rules']): MatchRuleSetInput => ({ id: null, name: 'draft', version: 0, rules });

const mentees = [
  { id: 'e1', fullName: 'Ece', skills: ['React'], languages: ['Turkish'] },
  { id: 'e2', fullName: 'Eli', skills: ['Go'], languages: ['German'] },
];
const mentors = [
  { id: 'r1', fullName: 'Rana', skills: ['React'], languages: ['Turkish'], activeMenteeCount: 0, mentorCapacity: 3 },
  { id: 'r2', fullName: 'Rolf', skills: ['Go', 'React'], languages: ['English'], activeMenteeCount: 2, mentorCapacity: 2 },
  { id: 'r3', fullName: 'Rhea', skills: [], languages: ['English'], activeMenteeCount: 0, mentorCapacity: null },
];

test.describe('match simulation', { tag: '@smoke' }, () => {
  test('weights normalise to whole percentages that sum to 100', () => {
    const w = (ws: number[]) => normalizedWeights(ws.map((weight) => ({ kind: 'WEIGHTED' as const, weight })));
    expect(w([30, 30, 30])).toEqual([34, 33, 33]);
    expect(w([30, 30, 30]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(w([50, 0, 25])).toEqual([67, 0, 33]);
    expect(w([0, 0])).toEqual([0, 0]);
    expect(normalizedWeights([{ kind: 'HARD_REQUIRE', weight: 80 }, { kind: 'WEIGHTED', weight: 10 }])).toEqual([0, 100]);
  });

  test('coverage, capacity and the top-N per mentee', () => {
    const { results, summary } = simulateRuleSet(mentees, mentors, set([
      { dimension: 'skills', kind: 'WEIGHTED', weight: 100 },
      { dimension: 'capacityHeadroom', kind: 'HARD_REQUIRE', weight: 0 },
    ]), { ctx: NOW });
    expect(summary).toMatchObject({ mentees: 2, withEligible: 2, mentors: 3, mentorsAtCapacity: 1 });
    expect(summary.mostEliminating).toEqual({ dimension: 'capacityHeadroom', count: 2 });
    expect(results[0].top.map((c) => c.mentorId)).toEqual(['r1', 'r3']);
    expect(results[0].eligible).toBe(2);
  });

  test('an over-tight set names the rule that eliminated everyone', () => {
    const { results, summary } = simulateRuleSet(mentees, mentors, set([
      { dimension: 'language', kind: 'HARD_REQUIRE', weight: 0 },
      { dimension: 'capacityHeadroom', kind: 'HARD_REQUIRE', weight: 0 },
    ]), { ctx: NOW });
    const eli = results.find((r) => r.menteeId === 'e2');
    expect(eli?.top).toEqual([]);
    expect(eli?.mostEliminating).toEqual({ dimension: 'language', count: 3 });
    expect(summary.withEligible).toBe(1);
    expect(summary.mostEliminating?.dimension).toBe('language');
  });

  test('two rule sets rank the same mentee differently', () => {
    const bySkills = simulateRuleSet([mentees[0]], mentors, set([{ dimension: 'skills', kind: 'WEIGHTED', weight: 100 }]), { ctx: NOW });
    const byCapacity = simulateRuleSet([mentees[0]], mentors, set([{ dimension: 'capacityHeadroom', kind: 'WEIGHTED', weight: 100 }]), { ctx: NOW });
    expect(bySkills.results[0].top.map((c) => c.mentorId)).toEqual(['r1', 'r2', 'r3']);
    expect(byCapacity.results[0].top.map((c) => c.mentorId)).toEqual(['r1', 'r3', 'r2']);
  });
});
