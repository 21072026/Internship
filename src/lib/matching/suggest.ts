/**
 * Mentor suggestions for one mentee (#1787) — the pure half of
 * `POST /api/admin/mentor-suggest`. Every candidate is scored by the ONE engine,
 * `scoreMatch()` with the org's rule set (#1781); this file only decides what
 * a suggestion list is made of. No Prisma, no clock of its own.
 *
 * Two rules sit above any rule set, because they are the mentor's own word or
 * the screen's honesty, not a weighting an admin tunes:
 *   - `acceptingMentees === false` always blocks — whatever the rule set says
 *     (#1779). The block is reported on `capacityHeadroom`, the availability
 *     dimension, so every screen names it with the label it already has.
 *   - a blocked mentor is never dropped in silence: they come back in
 *     `blocked`, with the rule that blocked them, instead of in the list.
 *
 * Nothing here assigns anybody. It ranks; a person decides.
 */

import type { MatchScore } from './types';
import type { MatchMentee, MatchMentor, ScoreContext } from './dimensions';
import { compareMatches, rankMatches, scoreMatch, type MatchRuleSetInput, type RankedMatch } from './score';

export const SUGGESTION_LIMIT = 5;
/** Bounds the payload; a blocked list longer than this is summarised by its count. */
export const BLOCKED_LIMIT = 20;

const NOT_ACCEPTING = 'not_accepting';

/** The mentor said no: blocked on availability whatever else the rules said. */
export function honourNotAccepting(match: MatchScore): MatchScore {
  const breakdown = match.breakdown.map((e) =>
    e.dimension === 'capacityHeadroom' ? { ...e, passed: false, detail: [...e.detail, NOT_ACCEPTING] } : e,
  );
  if (!breakdown.some((e) => e.dimension === 'capacityHeadroom')) {
    breakdown.push({ dimension: 'capacityHeadroom', kind: 'HARD_REQUIRE', weight: 0, ratio: 0, contribution: 0, passed: false, detail: [NOT_ACCEPTING] });
  }
  return {
    score: 0,
    breakdown: breakdown.map((e) => ({ ...e, contribution: 0 })),
    blockedBy: match.blockedBy.includes('capacityHeadroom') ? match.blockedBy : [...match.blockedBy, 'capacityHeadroom'],
  };
}

/** One pair, exactly as a suggestion list would score it (#1789 records this). */
export function scoreSuggestionPair(mentee: MatchMentee, mentor: MatchMentor, ruleSet: MatchRuleSetInput, ctx: ScoreContext): MatchScore {
  const match = scoreMatch(mentee, mentor, ruleSet, ctx);
  return mentor.acceptingMentees === false ? honourNotAccepting(match) : match;
}

export interface SuggestionSet<M extends MatchMentor> {
  /** Unblocked, best first (score, then the lighter load). */
  suggestions: RankedMatch<M>[];
  /** Mentors a hard rule (or their own "not accepting") ruled out, with why. */
  blocked: RankedMatch<M>[];
  blockedTotal: number;
}

export function suggestMentors<M extends MatchMentor>(
  mentee: MatchMentee,
  mentors: readonly M[],
  ruleSet: MatchRuleSetInput,
  ctx: ScoreContext,
  limit = SUGGESTION_LIMIT,
): SuggestionSet<M> {
  const ranked = rankMatches(mentee, mentors.filter((m) => m.id !== mentee.id), ruleSet, ctx)
    .map((r) => (r.mentor.acceptingMentees === false ? { ...r, match: honourNotAccepting(r.match) } : r))
    .sort(compareMatches);
  const blocked = ranked.filter((r) => r.match.blockedBy.length > 0);
  return {
    suggestions: ranked.filter((r) => r.match.blockedBy.length === 0).slice(0, limit),
    blocked: blocked.slice(0, BLOCKED_LIMIT),
    blockedTotal: blocked.length,
  };
}
