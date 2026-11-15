// The sales team page (/sales/team, #3779) — the queries (MARKETING only).
//
// One screen every rep of the tenant may open: how many records the team
// follows and where they stand, what came in, was won and was lost this week
// and this month, the open pipeline's estimated value, and one row per seller.
// It exists for motivation, so it shows names and COUNTS only — never a
// person's contact data, a lead's name or a note.
//
// The rules are not here. A win is `salesTargetRule.ts`'s (`wonCountsByOwner`,
// transfer chains folded, read through `loadWinCounts()`), a loss is its
// `lostCountsByOwner`, the month is `periodRange(currentPeriod())` and the week
// `weekRange()` — UTC, Monday-start, half-open. The leaderboard is
// `rankLeaderboard()` over the same counts, ranked by wins only and shown only
// where `canSeeLeaderboard()` says so: deliberately no points, streaks or
// activity counts (the billing meter counts logged activity, see that rule's
// header). An overdue follow-up is `isNextActionOverdue()`'s reading (a due day
// before today, UTC), expressed as a query bound.
//
// Every read is ANDed with the caller's tenant by hand (`withinTenant(…,
// tenantWhere(session))`, #2542), and everything on the request path is a
// `count` / `groupBy` on indexed columns, except the win/loss reads, which load
// only the deals with a matching move inside the window.
//
// SERVER-ONLY (Prisma).

import type { Session } from 'next-auth';
import type { Locale } from '@/i18n/config';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { resolvePipelineStages, outcomeStageKeysFrom, type ResolvedStage } from '@/lib/pipelineStages';
import { currentPeriod, periodRange } from '@/lib/meteringRules';
import { loadWinCounts } from '@/lib/salesTarget';
import {
  canSeeLeaderboard,
  earliestStart,
  lostCountsByOwner,
  parseLeaderboardForReps,
  rankLeaderboard,
  totalOf,
  weekRange,
  type RankedEntry,
} from '@/lib/salesTargetRule';

/** A team is a handful of sellers; the bound keeps a misconfigured org cheap. */
const REP_LIMIT = 200;

export interface StageCount {
  key: string;
  label: string;
  color: string | null;
  count: number;
}

export interface WindowCounts {
  newLeads: number;
  won: number;
  lost: number;
}

export interface PipelineValue {
  currency: string;
  totalMinor: number;
  deals: number;
}

export interface RepRow {
  userId: string;
  name: string;
  open: number;
  /** Open records per stage, in the tenant's stage order; stages with 0 left out. */
  stages: StageCount[];
  wonWeek: number;
  wonMonth: number;
  overdue: number;
}

export interface SalesTeamView {
  activeTotal: number;
  /** Every stage of the tenant, in its order, with the number of active records in it. */
  stages: StageCount[];
  week: WindowCounts;
  month: WindowCounts;
  /** One entry per currency — never converted, never summed across currencies. */
  pipelineValue: PipelineValue[];
  reps: RepRow[];
  /** null when the viewer may not see the ranked leaderboard. */
  leaderboard: { week: RankedEntry[]; month: RankedEntry[] } | null;
  leaderboardForReps: boolean;
}

/** Midnight UTC of `now`'s day — a next action due before it is overdue. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The team page for `session`'s tenant. The caller has already decided the
 * surface (`hasSalesSurface`) and the vertical (`salesTargetApplies`).
 */
export async function loadSalesTeamView(session: Session, locale: Locale = 'en', now: Date = new Date()): Promise<SalesTeamView> {
  const [tenant, settingsOrg] = await Promise.all([tenantWhere(session), settingsOrgOf(session)]);
  const [rawForReps, resolved] = await Promise.all([
    resolveSettingRaw('salesLeaderboardForReps', { orgId: settingsOrg }),
    resolvePipelineStages(session.user.orgId, locale),
  ]);
  const forReps = parseLeaderboardForReps(rawForReps);
  const ordered: ResolvedStage[] = [...resolved].sort((a, b) => a.order - b.order);
  const outcome = outcomeStageKeysFrom(ordered);
  const month = periodRange(currentPeriod(now));
  const week = weekRange(now);
  const active = withinTenant({ status: 'ACTIVE' as const }, tenant);
  const closedKeys = [...outcome.finished, ...outcome.offPath];

  const [byStage, byRepStage, overdueByRep, newMonth, newWeek, values, people, wins, lostDeals] = await Promise.all([
    prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: active, _count: { _all: true } }),
    prisma.mentorshipRelation.groupBy({ by: ['mentorId', 'pipelineStatus'], where: active, _count: { _all: true } }),
    prisma.mentorshipRelation.groupBy({
      by: ['mentorId'],
      where: withinTenant({ status: 'ACTIVE' as const, nextActionAt: { lt: startOfUtcDay(now) } }, tenant),
      _count: { _all: true },
    }),
    // A new lead is a new record — a transfer successor is the same deal, so
    // it carries a `previousRelationId` and is not counted again.
    prisma.mentorshipRelation.count({
      where: withinTenant({ previousRelationId: null, startDate: { gte: month.gte, lt: month.lt } }, tenant),
    }),
    prisma.mentorshipRelation.count({
      where: withinTenant({ previousRelationId: null, startDate: { gte: week.gte, lt: week.lt } }, tenant),
    }),
    // The open pipeline: active records not yet won or lost, by currency.
    prisma.relationValue.groupBy({
      by: ['currency'],
      where: { relation: withinTenant({ status: 'ACTIVE' as const, pipelineStatus: { notIn: closedKeys } }, tenant) },
      _sum: { valueMinor: true },
      _count: { _all: true },
    }),
    prisma.user.findMany({
      where: withinTenant({ role: { in: ['MENTOR', 'ADMIN'] as ('MENTOR' | 'ADMIN')[] }, isActive: true }, tenant),
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
      take: REP_LIMIT,
    }),
    loadWinCounts(tenant, outcome.finished, { month, week }),
    outcome.offPath.length === 0
      ? Promise.resolve([])
      : prisma.mentorshipRelation.findMany({
          where: withinTenant(
            { statusChanges: { some: { toStatus: { in: outcome.offPath }, createdAt: { gte: earliestStart(month, week), lt: month.lt > week.lt ? month.lt : week.lt } } } },
            tenant,
          ),
          select: {
            mentorId: true,
            statusChanges: { orderBy: { createdAt: 'asc' as const }, select: { fromStatus: true, toStatus: true, createdAt: true } },
          },
        }),
  ]);

  const lostHistories = lostDeals.map((d) => ({
    ownerId: d.mentorId,
    moves: d.statusChanges.map((c) => ({ fromStatus: c.fromStatus, toStatus: c.toStatus, at: c.createdAt.getTime() })),
  }));
  const lostMonth = lostCountsByOwner(lostHistories, outcome.offPath, month);
  const lostWeek = lostCountsByOwner(lostHistories, outcome.offPath, week);

  const stageMeta = (key: string, count: number): StageCount => {
    const s = ordered.find((x) => x.key === key);
    return { key, label: s?.label ?? key, color: s?.color ?? null, count };
  };
  const stageCount = new Map(byStage.map((g) => [g.pipelineStatus as string, g._count._all]));
  // Every configured stage, in order; a key no stage carries any more (a
  // deleted custom stage) still counts, at the end, so the total adds up.
  const stages: StageCount[] = [
    ...ordered.map((s) => stageMeta(s.key, stageCount.get(s.key) ?? 0)),
    ...[...stageCount.keys()].filter((k) => !ordered.some((s) => s.key === k)).map((k) => stageMeta(k, stageCount.get(k) ?? 0)),
  ];
  const activeTotal = stages.reduce((n, s) => n + s.count, 0);

  const repStages = new Map<string, Map<string, number>>();
  for (const g of byRepStage) {
    const m = repStages.get(g.mentorId) ?? new Map<string, number>();
    m.set(g.pipelineStatus as string, g._count._all);
    repStages.set(g.mentorId, m);
  }
  const overdue = new Map(overdueByRep.map((g) => [g.mentorId, g._count._all]));

  const reps: RepRow[] = people.map((p) => {
    const mine = repStages.get(p.id) ?? new Map<string, number>();
    const repStageList = stages.map((s) => ({ ...s, count: mine.get(s.key) ?? 0 })).filter((s) => s.count > 0);
    return {
      userId: p.id,
      name: p.fullName,
      open: repStageList.reduce((n, s) => n + s.count, 0),
      stages: repStageList,
      wonWeek: wins.week.get(p.id) ?? 0,
      wonMonth: wins.month.get(p.id) ?? 0,
      overdue: overdue.get(p.id) ?? 0,
    };
  });

  const leaderboard = canSeeLeaderboard(session.user.role, forReps)
    ? {
        week: rankLeaderboard(reps.map((r) => ({ userId: r.userId, name: r.name, won: r.wonWeek })), locale),
        month: rankLeaderboard(reps.map((r) => ({ userId: r.userId, name: r.name, won: r.wonMonth })), locale),
      }
    : null;

  return {
    activeTotal,
    stages,
    week: { newLeads: newWeek, won: totalOf(wins.week), lost: totalOf(lostWeek) },
    month: { newLeads: newMonth, won: totalOf(wins.month), lost: totalOf(lostMonth) },
    pipelineValue: values
      .map((v) => ({ currency: v.currency, totalMinor: v._sum.valueMinor ?? 0, deals: v._count._all }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    reps,
    leaderboard,
    leaderboardForReps: forReps,
  };
}
