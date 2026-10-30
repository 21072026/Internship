/**
 * The cohort pass (#1794, story #1791) — the pure half: every mentee in scope
 * scored against every mentor in scope, then ONE proposal per mentee. No
 * Prisma, no clock of its own; `cohortPass.ts` loads the two sides and writes
 * the rows. Nothing here (or there) creates a relation — the publish path
 * (#1796) is the only one that pairs anybody.
 *
 * The assignment strategy, because it will be questioned:
 *
 *   1. Mentors with `acceptingMentees === false` are out before any scoring —
 *      the mentor's own word, whatever the rule set says (#1779).
 *   2. Every (mentee × mentor) pair is scored by the ONE engine, `scoreMatch()`
 *      with the org's rule set and the mentee's skill graph — exactly the score
 *      a suggestion list shows for that pair (#1787). A pair is a CANDIDATE
 *      when no hard rule blocks it and its score reaches `minScore` (default
 *      `DEFAULT_MIN_SCORE`: a score of 0 is no reason to pair two people).
 *   3. All candidates are sorted by score descending, ties broken by mentorId,
 *      then menteeId (plain code-unit order, never locale order), and walked
 *      once: a pair is taken when its mentee is still unplaced and its mentor
 *      still has headroom. Headroom starts at `mentorCapacity − active
 *      relations` (no capacity = unlimited, the availability rule's reading)
 *      and goes down by one per proposal, so capacity is reserved INSIDE the
 *      pass — the best-matched mentor is not proposed to the whole intake.
 *   4. The issue's "second pass for the unplaced" is part of that one walk:
 *      the walk visits every candidate pair, so a mentee still unplaced at its
 *      end has no candidate whose mentor kept any headroom. Nobody is left out
 *      by the order of the walk alone.
 *
 * Global greedy, not an optimal assignment: it keeps the strongest pairs whole,
 * it is explainable in one sentence to a coordinator, and with the tie-break
 * it is deterministic — the same input always produces the same round, so a
 * coordinator re-running a discarded round never gets a different answer for
 * no reason.
 *
 * Every mentee gets a proposal. An unplaced one gets `mentorId: null` and one
 * reason from `UNMATCHED_REASONS`, decided in this order: nobody in scope at
 * all; every mentor blocked by a hard rule (named in `blockedBy`, the rule that
 * eliminated the most mentors first; when the only
 * rule is the capacity one, that is `all_at_capacity`); every unblocked mentor
 * under `minScore`; else the candidates' headroom ran out in the walk.
 */

import type { MatchScore } from './types';
import type { MatchMentee, MatchMentor, ScoreContext } from './dimensions';
import { scoreMatch, type MatchRuleSetInput } from './score';
import type { UnmatchedReason } from './round';

/** Hard ceilings of one pass in a request handler; above them the route answers 413. */
export const COHORT_PASS_MAX_MENTEES = 500;
export const COHORT_PASS_MAX_MENTORS = 1000;
/**
 * The minimum when the round names none: a pair with nothing in common (score
 * 0) is not a proposal. Without it an admin with no capacity set and no skills
 * — in the pool, unlimited headroom — would absorb every mentee nobody else fits.
 */
export const DEFAULT_MIN_SCORE = 1;
/** Candidates kept on each proposal so a swap on the board needs no re-run. */
export const PROPOSAL_ALTERNATIVES = 3;

const CAPACITY_RULE = 'capacityHeadroom';

export interface ProposalAlternative {
  mentorId: string;
  score: number;
  breakdown: MatchScore['breakdown'];
  blockedBy: string[];
  /** Headroom the mentor has left once the pass is done; null = unlimited. */
  headroomLeft: number | null;
}

export interface PassProposal {
  menteeId: string;
  mentorId: string | null;
  /** Rounded 0-100 (the column is an Int); null when unplaced. */
  score: number | null;
  breakdown: MatchScore['breakdown'];
  /** The hard rules that blocked every mentor (`no_eligible_mentor` / `all_at_capacity`). */
  blockedBy: string[];
  /** The chosen mentor's place in this mentee's own candidate order (1 = their best). */
  rank: number | null;
  alternatives: ProposalAlternative[];
  unmatchedReason: UnmatchedReason | null;
}

export interface PassStats {
  mentees: number;
  mentorsInScope: number;
  /** Excluded before scoring: acceptingMentees === false. */
  mentorsNotAccepting: number;
  scoredPairs: number;
  proposed: number;
  unmatched: Partial<Record<UnmatchedReason, number>>;
  mentorsUsed: number;
  /** Mentors with a capacity whose headroom the round used up (or had none to start with). */
  mentorsAtCapacity: number;
  /** Per hard rule, how many (mentee × mentor) pairs it blocked — the board's "too tight" signal. */
  blockedPairsByRule: Record<string, number>;
  minScore: number;
}

export interface PassResult {
  proposals: PassProposal[];
  stats: PassStats;
}

export interface PassInput<M extends MatchMentor> {
  mentees: readonly MatchMentee[];
  mentors: readonly M[];
  ruleSet: MatchRuleSetInput;
  /** Per mentee, so each one's skill graph is its own (#1821). Must be pure. */
  ctxFor: (mentee: MatchMentee) => ScoreContext;
  minScore?: number;
}

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Starting headroom; null = no capacity set, so no ceiling. */
export function startingHeadroom(mentor: Pick<MatchMentor, 'mentorCapacity' | 'activeMenteeCount'>): number | null {
  const cap = mentor.mentorCapacity;
  return cap == null ? null : Math.max(0, cap - mentor.activeMenteeCount);
}

interface Scored {
  mentor: number; // index into the sorted mentor list
  score: number;
  blockedBy: readonly string[];
}

export function runAssignment<M extends MatchMentor>(input: PassInput<M>): PassResult {
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
  const mentees = [...input.mentees].sort((a, b) => byCode(a.id, b.id));
  const accepting = input.mentors.filter((m) => m.acceptingMentees !== false);
  const mentors = [...accepting].sort((a, b) => byCode(a.id, b.id));
  const headroom = mentors.map(startingHeadroom);

  // Score once; keep only what the walk and the reasons need (the full
  // breakdowns of 500 × 1000 pairs would not fit a request comfortably — the
  // few that end up on a proposal are re-scored below, purely, so identically).
  const perMentee: Scored[][] = [];
  const candidates: { mentee: number; mentor: number; score: number }[] = [];
  let scoredPairs = 0;
  const blockedPairsByRule: Record<string, number> = {};
  mentees.forEach((mentee, ei) => {
    const ctx = input.ctxFor(mentee);
    const list: Scored[] = [];
    mentors.forEach((mentor, mi) => {
      if (mentor.id === mentee.id) return;
      const match = scoreMatch(mentee, mentor, input.ruleSet, ctx);
      scoredPairs++;
      for (const rule of match.blockedBy) blockedPairsByRule[rule] = (blockedPairsByRule[rule] ?? 0) + 1;
      list.push({ mentor: mi, score: match.score, blockedBy: match.blockedBy });
      if (match.blockedBy.length === 0 && match.score >= minScore) candidates.push({ mentee: ei, mentor: mi, score: match.score });
    });
    // The mentee's own order: unblocked first, score desc, mentorId asc.
    list.sort((a, b) =>
      Number(a.blockedBy.length > 0) - Number(b.blockedBy.length > 0) || b.score - a.score || byCode(mentors[a.mentor].id, mentors[b.mentor].id),
    );
    perMentee.push(list);
  });

  candidates.sort(
    (a, b) => b.score - a.score || byCode(mentors[a.mentor].id, mentors[b.mentor].id) || byCode(mentees[a.mentee].id, mentees[b.mentee].id),
  );
  const chosen = new Array<number | null>(mentees.length).fill(null);
  const used = new Set<number>();
  for (const c of candidates) {
    if (chosen[c.mentee] !== null) continue;
    const left = headroom[c.mentor];
    if (left !== null && left <= 0) continue;
    chosen[c.mentee] = c.mentor;
    if (left !== null) headroom[c.mentor] = left - 1;
    used.add(c.mentor);
  }

  const full = (ei: number, mi: number) => scoreMatch(mentees[ei], mentors[mi], input.ruleSet, input.ctxFor(mentees[ei]));
  const alternative = (ei: number, s: Scored): ProposalAlternative => {
    const match = full(ei, s.mentor);
    return { mentorId: mentors[s.mentor].id, score: round1(match.score), breakdown: match.breakdown, blockedBy: [...match.blockedBy], headroomLeft: headroom[s.mentor] };
  };

  const unmatched: Partial<Record<UnmatchedReason, number>> = {};
  const proposals = mentees.map((mentee, ei): PassProposal => {
    const list = perMentee[ei];
    const mi = chosen[ei];
    if (mi !== null) {
      const match = full(ei, mi);
      const eligible = list.filter((s) => s.blockedBy.length === 0 && s.score >= minScore);
      return {
        menteeId: mentee.id,
        mentorId: mentors[mi].id,
        score: Math.round(match.score),
        breakdown: match.breakdown,
        blockedBy: [],
        rank: eligible.findIndex((s) => s.mentor === mi) + 1,
        alternatives: eligible.filter((s) => s.mentor !== mi).slice(0, PROPOSAL_ALTERNATIVES).map((s) => alternative(ei, s)),
        unmatchedReason: null,
      };
    }
    const { reason, blockedBy } = unmatchedReasonFor(list, minScore);
    unmatched[reason] = (unmatched[reason] ?? 0) + 1;
    return {
      menteeId: mentee.id,
      mentorId: null,
      score: null,
      breakdown: [],
      blockedBy,
      rank: null,
      // The closest ones, blocked or not — the board shows why each was out.
      alternatives: list.slice(0, PROPOSAL_ALTERNATIVES).map((s) => alternative(ei, s)),
      unmatchedReason: reason,
    };
  });

  return {
    proposals,
    stats: {
      mentees: mentees.length,
      mentorsInScope: mentors.length,
      mentorsNotAccepting: input.mentors.length - accepting.length,
      scoredPairs,
      proposed: proposals.length - Object.values(unmatched).reduce((a, n) => a + (n ?? 0), 0),
      unmatched,
      mentorsUsed: used.size,
      mentorsAtCapacity: headroom.filter((h) => h !== null && h <= 0).length,
      blockedPairsByRule: Object.fromEntries(Object.entries(blockedPairsByRule).sort(([a], [b]) => byCode(a, b))),
      minScore,
    },
  };
}

/** Why a mentee with no proposal has none — see the header for the order. */
export function unmatchedReasonFor(
  list: readonly { score: number; blockedBy: readonly string[] }[],
  minScore: number,
): { reason: UnmatchedReason; blockedBy: string[] } {
  if (list.length === 0) return { reason: 'no_mentors_in_scope', blockedBy: [] };
  const unblocked = list.filter((s) => s.blockedBy.length === 0);
  if (unblocked.length === 0) {
    // Most-eliminating rule first: `blockedBy[0]` is the one to loosen.
    const counts = new Map<string, number>();
    for (const s of list) for (const r of s.blockedBy) counts.set(r, (counts.get(r) ?? 0) + 1);
    const rules = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || byCode(a, b));
    return { reason: rules.length === 1 && rules[0] === CAPACITY_RULE ? 'all_at_capacity' : 'no_eligible_mentor', blockedBy: rules };
  }
  if (!unblocked.some((s) => s.score >= minScore)) return { reason: 'below_threshold', blockedBy: [] };
  return { reason: 'all_at_capacity', blockedBy: [] };
}
