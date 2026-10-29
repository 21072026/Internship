// Unit tests for the scored mentor suggestions (#1787). Pure node — no
// browser, no DB.
//
// What is guarded: the `skills` dimension reads canonical ids with adjacency
// when — and only when — the caller hands it the org's skill graph (the dry
// run and requisition fit score exactly as before), a mentor who switched
// `acceptingMentees` off is blocked under ANY rule set, and a blocked mentor
// comes back in `blocked` with the rule that blocked them instead of vanishing.
import { test, expect } from '@playwright/test';
import { DEFAULT_RULE_SET, scoreMatch, type MatchRuleSetInput } from '@/lib/matching/score';
import { suggestMentors, honourNotAccepting } from '@/lib/matching/suggest';
import { matchRuleSetTag } from '@/lib/matchFeedback';

const now = new Date('2026-10-29T12:00:00Z');
const edges = [{ fromSkillId: 'react', toSkillId: 'frontend', weight: 0.5, kind: 'ADJACENT' as const }];
const graph = { edges, label: (id: string) => id.toUpperCase() };
const mentee = { id: 'me', skills: ['React'], skillIds: ['react'] };
const mentor = (id: string, over: Record<string, unknown> = {}) => ({ id, activeMenteeCount: 0, skills: [] as string[], skillIds: [] as string[], ...over });

test('skills: an adjacent canonical skill scores its edge weight, named', { tag: '@smoke' }, () => {
  const near = scoreMatch(mentee, mentor('near', { skillIds: ['frontend'] }), DEFAULT_RULE_SET, { now, skillGraph: graph });
  expect(near.score).toBe(50);
  expect(near.breakdown.find((e) => e.dimension === 'skills')?.detail).toEqual(['FRONTEND ≈ REACT']);
  const exact = scoreMatch(mentee, mentor('exact', { skillIds: ['react'] }), DEFAULT_RULE_SET, { now, skillGraph: graph });
  expect(exact.score).toBe(100);
});

test('skills: without the graph the free-text comparison is unchanged', { tag: '@smoke' }, () => {
  const freeText = scoreMatch(mentee, mentor('near', { skillIds: ['frontend'], skills: ['react'] }), DEFAULT_RULE_SET, { now });
  expect(freeText.score).toBe(100); // lower-cased string match, ids ignored
  const none = scoreMatch(mentee, mentor('near', { skillIds: ['frontend'] }), DEFAULT_RULE_SET, { now });
  expect(none.score).toBe(0);
});

test('suggest: ranked by score, blocked mentors returned separately with their rule', { tag: '@smoke' }, () => {
  const mentors = [
    mentor('near', { skillIds: ['frontend'] }),
    mentor('exact', { skillIds: ['react'] }),
    mentor('full', { skillIds: ['react'], mentorCapacity: 1, activeMenteeCount: 1 }),
  ];
  const out = suggestMentors(mentee, mentors, DEFAULT_RULE_SET, { now, skillGraph: graph });
  expect(out.suggestions.map((s) => s.mentor.id)).toEqual(['exact', 'near']);
  expect(out.blocked.map((b) => [b.mentor.id, b.match.blockedBy])).toEqual([['full', ['capacityHeadroom']]]);
  expect(out.blockedTotal).toBe(1);
});

test('suggest: acceptingMentees=false blocks under any rule set, even one without a capacity rule', { tag: '@smoke' }, () => {
  const skillsOnly: MatchRuleSetInput = { id: 'rs1', name: 'Skills only', version: 3, rules: [{ dimension: 'skills', kind: 'WEIGHTED', weight: 100 }] };
  const out = suggestMentors(mentee, [mentor('paused', { skillIds: ['react'], acceptingMentees: false })], skillsOnly, { now, skillGraph: graph });
  expect(out.suggestions).toEqual([]);
  expect(out.blocked[0].match.blockedBy).toEqual(['capacityHeadroom']);
  expect(out.blocked[0].match.score).toBe(0);
  expect(out.blocked[0].match.breakdown.find((e) => e.dimension === 'capacityHeadroom')?.passed).toBe(false);
});

test('suggest: the mentee is never suggested to themselves', { tag: '@smoke' }, () => {
  const out = suggestMentors(mentee, [mentor('me', { skillIds: ['react'] })], DEFAULT_RULE_SET, { now, skillGraph: graph });
  expect(out.suggestions).toEqual([]);
});

test('honourNotAccepting keeps an existing block and zeroes every contribution', { tag: '@smoke' }, () => {
  const m = honourNotAccepting({ score: 40, blockedBy: [], breakdown: [{ dimension: 'skills', kind: 'WEIGHTED', weight: 100, ratio: 0.4, contribution: 40, passed: true, detail: [] }] });
  expect(m.score).toBe(0);
  expect(m.breakdown.every((e) => e.contribution === 0)).toBe(true);
});

test('the recorded rule-set tag names the set and its version', { tag: '@smoke' }, () => {
  expect(matchRuleSetTag({ id: null, version: 1 })).toBe('rules-v3:default@1');
  expect(matchRuleSetTag({ id: 'abc', version: 7 })).toBe('rules-v3:abc@7');
});
