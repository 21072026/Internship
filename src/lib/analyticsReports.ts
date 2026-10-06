// The premium analytics computations, without a request (#1905).
//
// The cohort-comparison and source-conversion cards and the mentor-workload
// list used to compute their numbers inside their route handlers, which read
// the caller from the session. The report registry (src/lib/reports) reused
// those handlers in-process — fine for a signed-in admin, impossible for the
// scheduled report subscriptions, which run with no session at all. So the
// numbers live here, taking the tenant and the stage set explicitly, and the
// routes, the registry and the scheduled job all call the same function: one
// definition of "converted", not two.
//
// Who may see the result (role, ADVANCED_ANALYTICS, the `mentorship`
// capability) is still each CALLER's decision — nothing here gates.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { Locale } from '@/i18n/config';
import { outcomeStageKeys, type OutcomeStageKeys } from '@/lib/pipelineStages';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { attributedLeadWhere, sourceAttributionRows } from '@/lib/leadAttribution';

/**
 * The scope a computation runs in. `stageOrgId` is the org whose stage set
 * decides "finished" (null = the built-in catalogue, what an org-less admin's
 * session resolves to); `tenant` is the row filter (`tenantWhere`/`orgWhere`).
 */
export interface AnalyticsScope {
  stageOrgId: string | null;
  tenant: TenantWhere;
  locale: Locale;
}

export interface CohortComparisonRow {
  id: string;
  name: string;
  term: string | null;
  total: number;
  hired: number;
  dropped: number;
  inProgress: number;
  conversionToHired: number;
  avgDaysToHired: number | null;
  interactionsPerRelation: number;
}

export async function cohortComparison(scope: AnalyticsScope): Promise<{ rows: CohortComparisonRow[]; outcome: OutcomeStageKeys }> {
  const { tenant } = scope;
  const outcome = await outcomeStageKeys(scope.stageOrgId, scope.locale);
  const finished = new Set(outcome.finished);
  const offPath = new Set(outcome.offPath);
  const cohorts = await prisma.cohort.findMany({
    where: withinTenant({}, tenant),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      term: true,
      relations: {
        where: withinTenant({}, tenant),
        select: {
          pipelineStatus: true,
          startDate: true,
          _count: { select: { interactions: true } },
          statusChanges: {
            // Time-to-hire is measured to the tenant's OWN finished stage,
            // never to a key its pipeline may not contain.
            where: { toStatus: { in: outcome.finished } },
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { createdAt: true },
          },
        },
      },
    },
  });

  const rows = cohorts.map((c) => {
    const total = c.relations.length;
    const hired = c.relations.filter((r) => finished.has(r.pipelineStatus)).length;
    const dropped = c.relations.filter((r) => offPath.has(r.pipelineStatus)).length;
    const inProgress = total - hired - dropped;
    const interactions = c.relations.reduce((n, r) => n + r._count.interactions, 0);

    // Average days from relation start to the first transition INTO a
    // finished stage, over relations that actually got there (with a
    // recorded transition).
    const hireDurations = c.relations
      .map((r) => (r.statusChanges[0] ? (r.statusChanges[0].createdAt.getTime() - r.startDate.getTime()) / 86_400_000 : null))
      .filter((d): d is number => d !== null && d >= 0);
    const avgDaysToHired = hireDurations.length
      ? Math.round(hireDurations.reduce((a, b) => a + b, 0) / hireDurations.length)
      : null;

    return {
      id: c.id,
      name: c.name,
      term: c.term,
      total,
      hired,
      dropped,
      inProgress,
      conversionToHired: total ? Math.round((hired / total) * 100) : 0,
      avgDaysToHired,
      interactionsPerRelation: total ? Math.round((interactions / total) * 10) / 10 : 0,
    };
  });
  return { rows, outcome };
}

export async function sourceConversion(scope: AnalyticsScope) {
  const { tenant } = scope;
  const outcome = await outcomeStageKeys(scope.stageOrgId, scope.locale);
  const sources = await prisma.source.findMany({
    where: withinTenant({}, tenant),
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      users: {
        where: withinTenant(attributedLeadWhere(), tenant),
        select: { menteeRelations: { select: { pipelineStatus: true } } },
      },
    },
  });

  const rows = sourceAttributionRows(
    sources.map((s) => ({
      id: s.id,
      name: s.name,
      leads: s.users.map((u) => ({ stages: u.menteeRelations.map((r) => r.pipelineStatus) })),
    })),
    outcome.finished,
  );

  // People with no source at all, so the report accounts for everyone — the
  // untracked share is itself the answer to "how much of this do we know?".
  // "No source" means no source OF THIS TENANT: a lead whose `sourceId` points
  // at another tenant's row is counted here instead of vanishing from both
  // halves (#2570). The "outside" half is spelled per case because SQL's NOT
  // over a NULL is NULL. An `AND` of conjuncts, so neither `OR` can replace the
  // tenant fragment's.
  const outsideTenant: Prisma.SourceWhereInput | null =
    'orgId' in tenant
      ? { OR: [{ orgId: null }, { orgId: { not: tenant.orgId } }] }
      : 'OR' in tenant
        ? { AND: [{ orgId: { not: null } }, { orgId: { not: tenant.OR[0].orgId } }] }
        : null;
  const noSourceHere: Prisma.UserWhereInput = outsideTenant
    ? { OR: [{ sourceId: null }, { source: { is: outsideTenant } }] }
    : { sourceId: null };
  const unsourced = await prisma.user.count({
    where: withinTenant({ AND: [attributedLeadWhere(), noSourceHere] }, tenant),
  });
  return { rows, unsourced, outcome };
}

export interface MentorWorkloadRow {
  id: string;
  fullName: string;
  active: number;
  hired: number;
}

/** Relations per mentor and how many reached the tenant's finished stage, busiest first. */
export async function mentorWorkload(scope: AnalyticsScope, outcome?: OutcomeStageKeys): Promise<MentorWorkloadRow[]> {
  const { tenant } = scope;
  const [mentors, resolved] = await Promise.all([
    prisma.user.findMany({
      where: withinTenant({ role: 'MENTOR' as const }, tenant),
      select: {
        id: true,
        fullName: true,
        mentorRelations: { where: withinTenant({}, tenant), select: { pipelineStatus: true } },
      },
    }),
    outcome ?? outcomeStageKeys(scope.stageOrgId, scope.locale),
  ]);
  const finished = new Set(resolved.finished);
  return mentors
    .map((m) => ({
      id: m.id,
      fullName: m.fullName,
      active: m.mentorRelations.length,
      hired: m.mentorRelations.filter((r) => finished.has(r.pipelineStatus)).length,
    }))
    .sort((a, b) => b.active - a.active);
}
