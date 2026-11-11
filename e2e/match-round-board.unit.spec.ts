// Unit tests for the round board's rules (#1796). Pure node — no browser, no DB.
//
// Guarded: every board action is an edge the proposal lifecycle allows an
// admin (none reaches PUBLISHED), the unmatched panel groups by reason and
// names the most-blocking rule and the skills short of mentors with room, and
// a mentee blocked everywhere names the rule that eliminated the most mentors
// first.
import { test, expect } from '@playwright/test';
import { canTransitionProposal, PROPOSAL_ACTIONS } from '@/lib/matching/round';
import { roundDiagnostics } from '@/lib/matching/roundDiagnostics';
import { unmatchedReasonFor } from '@/lib/matching/assign';

test('every board action is an admin edge of the proposal lifecycle', { tag: '@smoke' }, () => {
  for (const { to, from } of Object.values(PROPOSAL_ACTIONS)) {
    expect(to).not.toBe('PUBLISHED');
    for (const f of from) expect(canTransitionProposal(f, to, 'admin')).toBe(true);
  }
});

test('diagnostics: grouped by reason, the most-blocking rule, the skills short of room', { tag: '@smoke' }, () => {
  const d = roundDiagnostics({
    proposals: [
      { menteeId: 'a', mentorId: null, unmatchedReason: 'all_at_capacity' },
      { menteeId: 'b', mentorId: null, unmatchedReason: 'all_at_capacity' },
      { menteeId: 'c', mentorId: null, unmatchedReason: 'no_eligible_mentor' },
      { menteeId: 'd', mentorId: 'm1', unmatchedReason: null },
    ],
    menteeSkills: new Map([['a', ['Python', 'SQL']], ['b', ['python ']], ['c', ['Go']]]),
    mentors: [
      { id: 'm1', skills: ['Python'], headroomLeft: 0 },
      { id: 'm2', skills: ['python'], headroomLeft: 1 },
      { id: 'm3', skills: ['SQL'], headroomLeft: null },
    ],
    blockedPairsByRule: { capacityHeadroom: 7, previousPairing: 2 },
  });
  expect(d.unmatchedTotal).toBe(3);
  expect(d.byReason).toEqual([
    { reason: 'no_eligible_mentor', count: 1, menteeIds: ['c'] },
    { reason: 'all_at_capacity', count: 2, menteeIds: ['a', 'b'] },
  ]);
  expect(d.topRule).toEqual({ rule: 'capacityHeadroom', pairs: 7 });
  // Python: 2 mentees, 1 mentor with room (m1 is full); Go: 1 vs 0; SQL is
  // covered. Equal gaps: the skill more people wait on comes first.
  expect(d.shortages).toEqual([
    { skill: 'Python', mentees: 2, mentorsWithHeadroom: 1 },
    { skill: 'Go', mentees: 1, mentorsWithHeadroom: 0 },
  ]);
});

test('diagnostics: nothing blocked and nobody unmatched reads as empty, not as an error', { tag: '@smoke' }, () => {
  expect(roundDiagnostics({ proposals: [], menteeSkills: new Map(), mentors: [], blockedPairsByRule: {} })).toEqual({
    unmatchedTotal: 0, byReason: [], topRule: null, shortages: [],
  });
});

test('a mentee blocked everywhere names the most-eliminating rule first', { tag: '@smoke' }, () => {
  const r = unmatchedReasonFor(
    [
      { score: 0, blockedBy: ['previousPairing'] },
      { score: 0, blockedBy: ['managerExclusion', 'previousPairing'] },
      { score: 0, blockedBy: ['capacityHeadroom'] },
    ],
    1,
  );
  expect(r).toEqual({ reason: 'no_eligible_mentor', blockedBy: ['previousPairing', 'capacityHeadroom', 'managerExclusion'] });
});
