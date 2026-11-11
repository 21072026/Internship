// Unit tests for the cohort pass (#1794). Pure node — no browser, no DB.
//
// What is guarded: capacity is reserved INSIDE the pass (a mentor is never
// proposed more often than their headroom), a mentor who is not accepting is
// in no proposal and no alternative, every mentee gets exactly one row and
// every unplaced one a reason (`no_eligible_mentor` naming the rule), the same
// input in any order gives the same round, and the pass loads each side once
// whatever the intake's size — no query per mentee, none per pair.
import { test, expect } from '@playwright/test';
import { DEFAULT_RULE_SET, type MatchRuleSetInput } from '@/lib/matching/score';
import { runAssignment, unmatchedReasonFor } from '@/lib/matching/assign';
import { runCohortPass, type CohortPassLoaders } from '@/lib/matching/cohortPass';
import type { MatchMentee, MatchMentor } from '@/lib/matching/dimensions';

const now = new Date('2026-10-29T12:00:00Z');
const ctxFor = () => ({ now });
const mentee = (id: string, skills: string[], over: Partial<MatchMentee> = {}): MatchMentee => ({ id, skills, ...over });
const mentor = (id: string, skills: string[], over: Partial<MatchMentor> = {}): MatchMentor => ({ id, skills, activeMenteeCount: 0, ...over });

test('capacity holds within the round: headroom = capacity − active, one per proposal', { tag: '@smoke' }, () => {
  const mentees = ['a', 'b', 'c', 'd', 'e'].map((id) => mentee(id, ['react']));
  const star = mentor('star', ['react'], { mentorCapacity: 3, activeMenteeCount: 1 }); // 2 seats left
  const { proposals, stats } = runAssignment({ mentees, mentors: [star], ruleSet: DEFAULT_RULE_SET, ctxFor });
  expect(proposals).toHaveLength(5);
  expect(proposals.filter((p) => p.mentorId === 'star')).toHaveLength(2);
  expect(proposals.filter((p) => p.mentorId === null).every((p) => p.unmatchedReason === 'all_at_capacity')).toBe(true);
  expect(stats).toMatchObject({ proposed: 2, unmatched: { all_at_capacity: 3 }, mentorsUsed: 1, mentorsAtCapacity: 1 });
});

test('the strongest pairs are kept whole; the next-best mentor takes the rest', { tag: '@smoke' }, () => {
  const mentees = [mentee('m1', ['react', 'sql']), mentee('m2', ['react'])];
  const mentors = [mentor('best', ['react', 'sql'], { mentorCapacity: 1 }), mentor('ok', ['react'], { mentorCapacity: 1 })];
  const { proposals } = runAssignment({ mentees, mentors, ruleSet: DEFAULT_RULE_SET, ctxFor });
  expect(proposals.find((p) => p.menteeId === 'm1')).toMatchObject({ mentorId: 'best', rank: 1, score: 100 });
  // Three pairs tie at 100; the walk takes (best, m1) first by mentorId then
  // menteeId, so `best` is full when (best, m2) comes up and m2 gets `ok`.
  expect(proposals.find((p) => p.menteeId === 'm2')).toMatchObject({ mentorId: 'ok' });
});

test('a mentor who is not accepting is in no proposal and no alternative', { tag: '@smoke' }, () => {
  const mentees = [mentee('a', ['react']), mentee('b', ['react'])];
  const mentors = [mentor('closed', ['react'], { acceptingMentees: false }), mentor('open', ['go'])];
  const { proposals, stats } = runAssignment({ mentees, mentors, ruleSet: DEFAULT_RULE_SET, ctxFor });
  const named = proposals.flatMap((p) => [p.mentorId, ...p.alternatives.map((a) => a.mentorId)]);
  expect(named).not.toContain('closed');
  expect(stats.mentorsNotAccepting).toBe(1);
});

test('every unplaced mentee has a reason, and no_eligible_mentor names the rule', { tag: '@smoke' }, () => {
  const strict: MatchRuleSetInput = {
    id: 'rs', name: 'Strict', version: 2,
    rules: [
      { dimension: 'skills', kind: 'WEIGHTED', weight: 100, config: { mode: 'lowercase' } },
      { dimension: 'previousPairing', kind: 'HARD_EXCLUDE', weight: 0, config: {} },
    ],
  };
  const mentees = [mentee('again', ['react'], { pastMentorIds: ['only'] }), mentee('low', ['rust'])];
  const { proposals } = runAssignment({ mentees, mentors: [mentor('only', ['react'])], ruleSet: strict, ctxFor, minScore: 50 });
  expect(proposals.find((p) => p.menteeId === 'again')).toMatchObject({ mentorId: null, unmatchedReason: 'no_eligible_mentor', blockedBy: ['previousPairing'] });
  expect(proposals.find((p) => p.menteeId === 'low')).toMatchObject({ mentorId: null, unmatchedReason: 'below_threshold' });
  expect(runAssignment({ mentees, mentors: [], ruleSet: strict, ctxFor }).proposals.every((p) => p.unmatchedReason === 'no_mentors_in_scope')).toBe(true);
  expect(unmatchedReasonFor([{ score: 0, blockedBy: ['capacityHeadroom'] }], 0).reason).toBe('all_at_capacity');
});

test('alternatives: the next three candidates, with score, breakdown and headroom left', { tag: '@smoke' }, () => {
  const mentors = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => mentor(id, ['react'], { mentorCapacity: 2 }));
  const { proposals } = runAssignment({ mentees: [mentee('x', ['react'])], mentors, ruleSet: DEFAULT_RULE_SET, ctxFor });
  expect(proposals[0].mentorId).toBe('m1');
  expect(proposals[0].alternatives.map((a) => a.mentorId)).toEqual(['m2', 'm3', 'm4']);
  expect(proposals[0].alternatives[0]).toMatchObject({ score: 100, blockedBy: [], headroomLeft: 2 });
  expect(proposals[0].alternatives[0].breakdown.length).toBeGreaterThan(0);
});

test('deterministic: the same people in any order give the same round', { tag: '@smoke' }, () => {
  const skills = ['react', 'sql', 'go', 'python', 'figma'];
  const mentees = Array.from({ length: 40 }, (_, i) => mentee(`e${String(i).padStart(2, '0')}`, [skills[i % 5], skills[(i * 3) % 5]]));
  const mentors = Array.from({ length: 12 }, (_, i) => mentor(`r${String(i).padStart(2, '0')}`, [skills[i % 5]], { mentorCapacity: 2 + (i % 3), activeMenteeCount: i % 2 }));
  const once = runAssignment({ mentees, mentors, ruleSet: DEFAULT_RULE_SET, ctxFor });
  const shuffled = runAssignment({ mentees: [...mentees].reverse(), mentors: [...mentors.slice(5), ...mentors.slice(0, 5)], ruleSet: DEFAULT_RULE_SET, ctxFor });
  expect(JSON.stringify(shuffled)).toBe(JSON.stringify(once));
  for (const m of mentors) {
    const seats = (m.mentorCapacity ?? 0) - m.activeMenteeCount;
    expect(once.proposals.filter((p) => p.mentorId === m.id).length).toBeLessThanOrEqual(seats);
  }
});

function countingLoaders(menteeCount: number, mentorCount = 4) {
  const calls: Record<string, number> = {};
  const hit = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };
  const mentees = Array.from({ length: menteeCount }, (_, i) => mentee(`e${i}`, ['react']));
  const mentors = Array.from({ length: mentorCount }, (_, i) => mentor(`r${i}`, ['react'], { mentorCapacity: 100 }));
  const loaders: CohortPassLoaders<MatchMentee, MatchMentor> = {
    menteeIds: async (limit) => { hit('menteeIds'); return mentees.slice(0, limit).map((m) => m.id); },
    mentorCount: async () => { hit('mentorCount'); return mentors.length; },
    mentees: async (ids) => { hit('mentees'); return mentees.filter((m) => ids.includes(m.id)); },
    mentors: async () => { hit('mentors'); return mentors; },
    skillIds: async () => { hit('skillIds'); return new Map(); },
    preferences: async () => { hit('preferences'); return new Map(); },
    skillGraphs: async () => { hit('skillGraphs'); return () => undefined; },
    ruleSet: async () => { hit('ruleSet'); return DEFAULT_RULE_SET; },
  };
  return { loaders, calls };
}

test('no N+1: every loader runs once, whatever the intake size', { tag: '@smoke' }, async () => {
  for (const size of [3, 300]) {
    const { loaders, calls } = countingLoaders(size);
    const outcome = await runCohortPass(loaders, { now });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.proposals).toHaveLength(size);
    expect(Object.values(calls).every((n) => n === 1)).toBe(true);
    expect(Object.keys(calls)).toHaveLength(8);
  }
});

test('over the cap: too_large before anything is loaded or scored', { tag: '@smoke' }, async () => {
  const big = countingLoaders(501);
  expect(await runCohortPass(big.loaders, { now })).toMatchObject({ ok: false, code: 'too_large', mentees: 501, maxMentees: 500 });
  expect(big.calls.mentees).toBeUndefined();
  const wide = countingLoaders(2, 1001);
  expect(await runCohortPass(wide.loaders, { now })).toMatchObject({ ok: false, code: 'too_large', mentors: 1001 });
});
