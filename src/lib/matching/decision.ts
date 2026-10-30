/**
 * recordMatchDecision() — the ONE writer of `MatchDecision` (#1789), called
 * from every place a pairing is created: the direct assignment
 * (`POST /api/mentorship`), the request approval and the mentor's own accept
 * (both `decideMentorshipRequest()`).
 *
 * Like `logActivity()` it never throws: the pairing has already been committed
 * when this runs, and a failed audit write must not turn a done assignment into
 * an error. It is logged loudly instead (`match_decision.write_failed`).
 *
 * The score is computed HERE, at decision time, with the org's live rule set —
 * the same scorer and the same inputs as the suggestion list
 * (`scoreSuggestionPair`, `skillGraphFor`) — and stored as a frozen copy, so a
 * later edit or archive of the rule set cannot rewrite history. Whether the
 * decision overrode the ranking comes from the MatchFeedback rows the server
 * wrote when it showed the list, keyed by the batch id the client echoes back.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { resolveRuleSet } from './ruleSet';
import { loadPairForScoring } from './pool';
import { skillGraphFor, skillIdsByUser } from './skillContext';
import { scoreSuggestionPair } from './suggest';
import { frozenScore, MATCH_DECISION_NOTE_MAX, rankingOutcome, type MatchDecisionSourceKey } from './decisionRule';

export interface MatchDecisionInput {
  orgId: string | null;
  relationId: string | null;
  menteeId: string;
  mentorId: string;
  source: MatchDecisionSourceKey;
  decidedById: string;
  requestId?: string | null;
  roundId?: string | null;
  /** The MatchFeedback batch the decider was shown, if any (client-echoed id, server-read rows). */
  suggestionBatchId?: string | null;
  note?: string | null;
  /** Labels the frozen skill evidence; defaults to English. */
  locale?: string;
  /**
   * The score the decider actually saw, frozen elsewhere — a published round's
   * proposal (#1796), scored by the cohort pass under the round's rule set.
   * When given it is recorded as is, instead of re-scoring the pair now.
   */
  snapshot?: {
    score: number | null;
    breakdown: unknown;
    blockedBy: unknown;
    ruleSetId: string | null;
    ruleSetVersion: number | null;
  };
}

export async function recordMatchDecision(input: MatchDecisionInput): Promise<string | null> {
  try {
    const given = input.snapshot;
    const pair = given ? null : await loadPairForScoring(input.menteeId, input.mentorId);
    const live = given ? null : await resolveRuleSet(input.orgId);
    const ruleSet = given ? { id: given.ruleSetId, version: given.ruleSetVersion } : { id: live!.id, version: live!.version };
    let snapshot: { score: number | null; breakdown: unknown; blockedBy: unknown } | null = given ?? null;
    if (pair && live) {
      const request = input.requestId
        ? await prisma.mentorshipRequest.findUnique({
            where: { id: input.requestId },
            select: { preferredField: true, preferredLanguages: true },
          })
        : null;
      const skills = await skillIdsByUser([input.menteeId, input.mentorId]);
      const menteeSkillIds = skills.get(input.menteeId) ?? [];
      const skillGraph = await skillGraphFor(input.orgId, menteeSkillIds, input.locale ?? 'en');
      // The pairing is already live, so the mentor's load counts it once too
      // many — score the load they had when the decision was taken.
      const mentor = { ...pair.mentor, activeMenteeCount: Math.max(0, pair.mentor.activeMenteeCount - 1), skillIds: skills.get(input.mentorId) ?? [] };
      // Likewise the new relation is already among the mentee's pairings; drop
      // that one occurrence, or `previousPairing` would block the very pair
      // being recorded. An earlier pairing with the same mentor still counts.
      const past = [...(pair.mentee.pastMentorIds ?? [])];
      const own = past.indexOf(input.mentorId);
      if (own >= 0) past.splice(own, 1);
      const mentee = {
        ...pair.mentee,
        pastMentorIds: past,
        skillIds: menteeSkillIds,
        preferredField: request?.preferredField ?? null,
        preferredLanguages: request?.preferredLanguages ?? [],
      };
      snapshot = frozenScore(scoreSuggestionPair(mentee, mentor, live, { now: new Date(), ...(skillGraph ? { skillGraph } : {}) }));
    }

    const shown = input.suggestionBatchId
      ? await prisma.matchFeedback.findMany({
          where: { batchId: input.suggestionBatchId, menteeId: input.menteeId, action: 'SHOWN' },
          select: { mentorId: true, rank: true },
        })
      : [];
    const ranking = rankingOutcome(shown, input.mentorId);
    const note = input.note?.trim() ? input.note.trim().slice(0, MATCH_DECISION_NOTE_MAX) : null;

    const row = await prisma.matchDecision.create({
      data: {
        orgId: input.orgId,
        relationId: input.relationId,
        menteeId: input.menteeId,
        mentorId: input.mentorId,
        requestId: input.requestId ?? null,
        roundId: input.roundId ?? null,
        source: input.source,
        score: snapshot?.score ?? null,
        breakdown: (snapshot?.breakdown ?? []) as unknown as Prisma.InputJsonValue,
        blockedBy: (snapshot?.blockedBy ?? []) as unknown as Prisma.InputJsonValue,
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
        suggestedRank: ranking.suggestedRank,
        overrodeSuggestion: ranking.overrodeSuggestion,
        note,
        decidedById: input.decidedById,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    logger.error('match_decision.write_failed', {
      relationId: input.relationId,
      menteeId: input.menteeId,
      mentorId: input.mentorId,
      source: input.source,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
