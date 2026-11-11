/**
 * Scoring a swapped proposal on the round board (#1796) — server-side, always.
 * A score the browser sends is never read: the pair is re-scored here by the
 * same engine and inputs as the cohort pass (`scoreSuggestionPair`, the org's
 * rule set, the mentee's skill graph, a pending request's preferences, the
 * round's own instant). Server-only (Prisma).
 *
 * Capacity counts the round's own reservations: every other proposal in this
 * round that holds the mentor's seat (DRAFT or LOCKED) is added to their live
 * load before `capacityHeadroom` judges — a swap must not overbook the mentor
 * the pass had carefully filled.
 */

import { prisma } from '@/lib/prisma';
import type { TenantWhere } from '@/lib/tenantFilter';
import { loadPairForScoring, mentorPoolWhere } from './pool';
import { resolveRuleSet } from './ruleSet';
import { skillGraphFor, skillIdsByUser } from './skillContext';
import { scoreSuggestionPair } from './suggest';
import { SEAT_HOLDING_STATES } from './round';
import type { MatchScore } from './types';

export type SwapScore =
  | { ok: true; match: MatchScore }
  | { ok: false; code: 'mentor_not_in_pool' | 'mentee_missing' | 'same_person' };

export async function scoreSwap(opts: {
  tenant: TenantWhere;
  orgId: string | null;
  round: { id: string; createdAt: Date };
  proposalId: string;
  menteeId: string;
  mentorId: string;
  locale: string;
}): Promise<SwapScore> {
  if (opts.menteeId === opts.mentorId) return { ok: false, code: 'same_person' };
  const inPool = await prisma.user.findFirst({ where: { AND: [mentorPoolWhere(opts.tenant), { id: opts.mentorId }] }, select: { id: true } });
  if (!inPool) return { ok: false, code: 'mentor_not_in_pool' };
  const pair = await loadPairForScoring(opts.menteeId, opts.mentorId);
  if (!pair) return { ok: false, code: 'mentee_missing' };

  const [reserved, skills, request, ruleSet] = await Promise.all([
    prisma.matchProposal.count({
      where: { roundId: opts.round.id, mentorId: opts.mentorId, state: { in: [...SEAT_HOLDING_STATES] }, id: { not: opts.proposalId } },
    }),
    skillIdsByUser([opts.menteeId, opts.mentorId]),
    prisma.mentorshipRequest.findFirst({
      where: { menteeId: opts.menteeId, status: 'PENDING' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { preferredField: true, preferredLanguages: true },
    }),
    resolveRuleSet(opts.orgId),
  ]);
  const menteeSkillIds = skills.get(opts.menteeId) ?? [];
  const skillGraph = await skillGraphFor(opts.orgId, menteeSkillIds, opts.locale);
  const match = scoreSuggestionPair(
    {
      ...pair.mentee,
      skillIds: menteeSkillIds,
      preferredField: request?.preferredField ?? null,
      preferredLanguages: request?.preferredLanguages ?? [],
    },
    { ...pair.mentor, activeMenteeCount: pair.mentor.activeMenteeCount + reserved, skillIds: skills.get(opts.mentorId) ?? [] },
    ruleSet,
    { now: opts.round.createdAt, ...(skillGraph ? { skillGraph } : {}) },
  );
  return { ok: true, match };
}
