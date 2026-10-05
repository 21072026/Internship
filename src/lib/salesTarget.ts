// Monthly won-deal target and team leaderboard — the queries (MARKETING only).
//
// The rule (what a win is, ranking, progress) is src/lib/salesTargetRule.ts and
// is unit-tested there; this file only loads rows. Every read is the caller's
// tenant by hand (`withinTenant(…, tenantWhere(session))`, #2542) — a rep in
// one org must never see another org's names or counts, whether or not
// MT_ENFORCE_ISOLATION is on. The month is `currentPeriod()`/`periodRange()`
// from src/lib/meteringRules.ts and nothing else.
//
// SERVER-ONLY (Prisma).

import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { getSetting } from '@/lib/settings';
import { resolvePipelineStages, outcomeStageKeysFrom } from '@/lib/pipelineStages';
import { currentPeriod, periodRange, type Period } from '@/lib/meteringRules';
import {
  canSeeLeaderboard,
  parseLeaderboardForReps,
  parseWonTarget,
  rankLeaderboard,
  targetProgress,
  wonCountsByOwner,
  type RankedEntry,
  type TargetProgress,
} from '@/lib/salesTargetRule';

export interface SalesTargetView {
  period: Period;
  /** The viewer's own wins this month against the org's target. */
  own: TargetProgress;
  /** null when the viewer may not see it. */
  leaderboard: RankedEntry[] | null;
  /** Whether reps see the leaderboard (an admin is told, so the card can say so). */
  leaderboardForReps: boolean;
}

/**
 * The viewer's won-this-month card and, when allowed, the team leaderboard.
 * The caller has already decided the vertical (`salesTargetApplies`).
 */
export async function loadSalesTargetView(session: Session, locale = 'en', now: Date = new Date()): Promise<SalesTargetView> {
  const userId = session.user.id;
  const [tenant, settingsOrg] = await Promise.all([tenantWhere(session), settingsOrgOf(session)]);
  const [rawTarget, rawForReps, stages] = await Promise.all([
    getSetting('salesMonthlyWonTarget', settingsOrg),
    getSetting('salesLeaderboardForReps', settingsOrg),
    resolvePipelineStages(session.user.orgId),
  ]);
  const target = parseWonTarget(rawTarget);
  const forReps = parseLeaderboardForReps(rawForReps);
  const showBoard = canSeeLeaderboard(session.user.role, forReps);
  const wonKeys = outcomeStageKeysFrom(stages).finished;
  const period = currentPeriod(now);
  const range = periodRange(period);

  // Only deals that moved into a won stage this month can be a win this month;
  // their WHOLE history is loaded, because "first win" and "started won" are
  // read from the oldest move. Without the board, only the viewer's own deals.
  // A transfer successor's predecessors are loaded too (same tenant), because
  // a chain is one deal — a re-win after a handover is not a second win (see
  // the rule's header). They only ever SUBTRACT: a predecessor without a won
  // move this month cannot add a win of its own.
  const select = {
    id: true,
    previousRelationId: true,
    mentorId: true,
    statusChanges: { orderBy: { createdAt: 'asc' as const }, select: { fromStatus: true, toStatus: true, createdAt: true } },
  };
  const deals =
    wonKeys.length === 0
      ? []
      : await prisma.mentorshipRelation.findMany({
          where: withinTenant(
            {
              ...(showBoard ? {} : { mentorId: userId }),
              statusChanges: { some: { toStatus: { in: wonKeys }, createdAt: { gte: range.gte, lt: range.lt } } },
            },
            tenant,
          ),
          select,
        });
  const loaded = new Set(deals.map((d) => d.id));
  // Bounded: chains are a handful of links; a cycle (no write path makes one)
  // stops at the `loaded` check.
  for (let depth = 0; depth < 20; depth++) {
    const missing = [...new Set(deals.map((d) => d.previousRelationId).filter((id): id is string => !!id && !loaded.has(id)))];
    if (missing.length === 0) break;
    const prev = await prisma.mentorshipRelation.findMany({ where: withinTenant({ id: { in: missing } }, tenant), select });
    for (const id of missing) loaded.add(id);
    deals.push(...prev);
  }
  const counts = wonCountsByOwner(
    deals.map((d) => ({
      id: d.id,
      previousId: d.previousRelationId,
      ownerId: d.mentorId,
      moves: d.statusChanges.map((c) => ({ fromStatus: c.fromStatus, toStatus: c.toStatus, at: c.createdAt.getTime() })),
    })),
    wonKeys,
    range,
  );
  const own = targetProgress(counts.get(userId) ?? 0, target);
  if (!showBoard) return { period, own, leaderboard: null, leaderboardForReps: forReps };

  // Who is on the board: every active rep AND every active admin of the org (a
  // person with no win yet is on it at 0 — leaving them off would make the
  // board a list of winners; admins sell in small teams, so they are always
  // listed, maintainer decision 2026-10-05), plus anyone else of the org who
  // owns a deal won this month. Names only; nothing about the deals themselves.
  const people = await prisma.user.findMany({
    where: withinTenant(
      {
        OR: [
          { role: { in: ['MENTOR', 'ADMIN'] as ('MENTOR' | 'ADMIN')[] }, isActive: true },
          { id: { in: [...counts.keys()] } },
        ],
      },
      tenant,
    ),
    select: { id: true, fullName: true },
  });
  const leaderboard = rankLeaderboard(
    people.map((p) => ({ userId: p.id, name: p.fullName, won: counts.get(p.id) ?? 0 })),
    locale,
  );
  return { period, own, leaderboard, leaderboardForReps: forReps };
}
