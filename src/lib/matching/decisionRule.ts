/**
 * The pure half of the per-pairing audit record (#1789). What a MatchDecision
 * says about the ranking is decided here, from data the SERVER holds — the
 * suggestion batch it recorded when the list was shown (MatchFeedback SHOWN
 * rows) — never from a flag the client sends.
 */

import type { MatchScore } from './types';

export const MATCH_DECISION_SOURCES = ['ADMIN_DIRECT', 'REQUEST_APPROVAL', 'MENTOR_ACCEPT', 'BULK_ROUND', 'MENTEE_PREFERENCE'] as const;
export type MatchDecisionSourceKey = (typeof MATCH_DECISION_SOURCES)[number];

/** The admin's "why this mentor" note; the same cap as a feedback note, longer. */
export const MATCH_DECISION_NOTE_MAX = 1000;

/**
 * Where the chosen mentor sat in the list the decider was shown, and whether
 * picking them overrode it. No batch (nothing was suggested) → no rank and no
 * override: you cannot overrule a ranking you never saw. A batch whose rank 1
 * is somebody else → override, whether the chosen mentor was further down or
 * not on the list at all.
 */
export function rankingOutcome(
  shown: readonly { mentorId: string; rank: number | null }[],
  chosenMentorId: string,
): { suggestedRank: number | null; overrodeSuggestion: boolean } {
  const ranked = shown.filter((r) => r.rank != null);
  if (ranked.length === 0) return { suggestedRank: null, overrodeSuggestion: false };
  const hit = ranked.find((r) => r.mentorId === chosenMentorId);
  const suggestedRank = hit ? (hit.rank as number) : null;
  return { suggestedRank, overrodeSuggestion: suggestedRank !== 1 };
}

/**
 * The frozen copy written onto the decision: rounded score, the rule rows and
 * the blocking rules, deep-copied so a later edit of anything the caller holds
 * can never reach the stored row.
 */
export function frozenScore(match: MatchScore): { score: number; breakdown: MatchScore['breakdown']; blockedBy: string[] } {
  return {
    score: Math.round(match.score),
    breakdown: JSON.parse(JSON.stringify(match.breakdown)),
    blockedBy: [...match.blockedBy],
  };
}
