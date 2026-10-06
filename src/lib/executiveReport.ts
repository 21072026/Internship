// The executive dashboard's data load (#1895). Counts only — the arithmetic
// and the formulas live in src/lib/executiveScores.ts (pure, unit-tested), so
// the screen shows exactly the expression each score was computed with.
// docs/executive-dashboard.md is the human-readable copy.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { resolvePipelineStages, onPathKeys, outcomeStageKeysFrom } from '@/lib/pipelineStages';
import { relationsInContactBetween } from '@/lib/lastContact';
import type { Locale } from '@/i18n/config';
import { activeIn, isForward, scoreOf, trendPeriods, type Period, type ScorePoint } from '@/lib/executiveScores';

const DAY = 24 * 60 * 60 * 1000;

export interface ExecutiveReport {
  periods: Period[];
  engagement: ScorePoint[];
  progression: ScorePoint[];
  placement: ScorePoint[];
  /** The tenant's finished stage, by its own label (#1882). */
  finishedLabel: string;
}

const bounds = (p: Period) => ({ start: new Date(`${p.from}T00:00:00Z`), end: new Date(Date.parse(`${p.to}T00:00:00Z`) + DAY) });

export async function loadExecutiveReport(
  tenant: TenantWhere,
  settingsOrgId: string,
  locale: Locale,
  window: Period,
  cohortId: string | null,
): Promise<ExecutiveReport> {
  const periods = trendPeriods(window.from, window.to);
  const first = bounds(periods[0]).start;
  const last = bounds(periods[periods.length - 1]).end;

  // Every relation that could have been active in any of the periods.
  const where: Prisma.MentorshipRelationWhereInput = withinTenant(
    {
      ...(cohortId ? { cohortId } : {}),
      startDate: { lt: last },
      OR: [{ status: 'ACTIVE' as const }, { completedAt: { gte: first } }],
    },
    tenant,
  );
  const relations = await prisma.mentorshipRelation.findMany({
    where,
    select: { id: true, menteeId: true, startDate: true, status: true, completedAt: true },
  });
  const ids = relations.map((r) => r.id);

  const stages = await resolvePipelineStages(settingsOrgId, locale);
  const onPath = onPathKeys(stages);
  const outcome = outcomeStageKeysFrom(stages);

  const [moves, firstFinished] = ids.length
    ? await Promise.all([
        prisma.statusChange.findMany({
          where: { relationId: { in: ids }, createdAt: { gte: first, lt: last } },
          select: { relationId: true, fromStatus: true, toStatus: true, createdAt: true },
        }),
        outcome.finished.length
          ? prisma.statusChange.groupBy({ by: ['relationId'], where: { relationId: { in: ids }, toStatus: { in: outcome.finished } }, _min: { createdAt: true } })
          : Promise.resolve([] as { relationId: string; _min: { createdAt: Date | null } }[]),
      ])
    : [[], []];
  const finishedAt = new Map(firstFinished.map((f) => [f.relationId, f._min.createdAt]));

  const engagement: ScorePoint[] = [];
  const progression: ScorePoint[] = [];
  const placement: ScorePoint[] = [];
  for (const period of periods) {
    const { start, end } = bounds(period);
    const active = relations.filter((r) => activeIn(r, period));
    const activeIds = new Set(active.map((r) => r.id));
    const engaged = await relationsInContactBetween(active, start, end);
    const advanced = new Set(
      moves
        .filter((m) => activeIds.has(m.relationId) && m.createdAt >= start && m.createdAt < end && isForward(onPath, m.fromStatus, m.toStatus))
        .map((m) => m.relationId),
    );
    const placed = active.filter((r) => {
      const at = finishedAt.get(r.id);
      return at && at >= start && at < end;
    }).length;
    const point = (numerator: number): ScorePoint => ({ period, numerator, denominator: active.length, score: scoreOf(numerator, active.length) });
    engagement.push(point(engaged.size));
    progression.push(point(advanced.size));
    placement.push(point(placed));
  }

  return { periods, engagement, progression, placement, finishedLabel: outcome.finishedLabel };
}
