// The breach queue and the compliance rate (#1723), server side. Both take the
// caller's tenant fragment (`tenantWhere(session)`), never an orgId from the
// request, and both leave out the populations the overdue list leaves out.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { stageClockStopped } from '@/lib/stageClock';
import { loadStageSlaRows } from '@/lib/stageSla';
import { slaDaysByStage } from '@/lib/stageSlaRule';
import { computeSlaCompliance, type ComplianceResult } from '@/lib/slaCompliance';
import { daysOverdue } from '@/lib/slaLadderRule';

export const SLA_QUEUE_PAGE_SIZE = 25;

export interface SlaQueueFilters {
  stage?: string | null;
  level?: number | null;
  ownerId?: string | null;
  /** 'yes' = acknowledged only, 'no' = not acknowledged only. */
  acknowledged?: 'yes' | 'no' | null;
  /** Free text over the mentee's name. */
  q?: string | null;
  page?: number;
}

export interface SlaQueueItem {
  id: string;
  relationId: string;
  menteeId: string;
  menteeName: string;
  ownerId: string;
  ownerName: string;
  stageKey: string;
  dueAt: string;
  daysPastDue: number;
  level: number;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
}

/** One page of open breaches, oldest deadline first. */
export async function listOpenBreaches(
  tenant: TenantWhere,
  filters: SlaQueueFilters,
  now: Date = new Date()
): Promise<{ items: SlaQueueItem[]; total: number; page: number; pageSize: number }> {
  const relation: Prisma.MentorshipRelationWhereInput = {};
  if (filters.ownerId) relation.mentorId = filters.ownerId;
  if (filters.q) relation.mentee = { fullName: { contains: filters.q } };
  const where: Prisma.SlaBreachWhereInput = withinTenant(
    {
      resolvedAt: null,
      ...(filters.stage ? { stageKey: filters.stage } : {}),
      ...(filters.level ? { level: filters.level } : {}),
      ...(filters.acknowledged === 'yes' ? { acknowledgedAt: { not: null } } : {}),
      ...(filters.acknowledged === 'no' ? { acknowledgedAt: null } : {}),
      ...(Object.keys(relation).length ? { relation } : {}),
    },
    tenant
  );
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const [total, rows] = await Promise.all([
    prisma.slaBreach.count({ where }),
    prisma.slaBreach.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      skip: (page - 1) * SLA_QUEUE_PAGE_SIZE,
      take: SLA_QUEUE_PAGE_SIZE,
      select: {
        id: true,
        relationId: true,
        stageKey: true,
        dueAt: true,
        level: true,
        acknowledgedAt: true,
        snoozedUntil: true,
        relation: {
          select: {
            menteeId: true,
            mentee: { select: { fullName: true } },
            mentor: { select: { id: true, fullName: true } },
          },
        },
      },
    }),
  ]);
  return {
    total,
    page,
    pageSize: SLA_QUEUE_PAGE_SIZE,
    items: rows.map((b) => ({
      id: b.id,
      relationId: b.relationId,
      menteeId: b.relation.menteeId,
      menteeName: b.relation.mentee.fullName,
      ownerId: b.relation.mentor.id,
      ownerName: b.relation.mentor.fullName,
      stageKey: b.stageKey,
      dueAt: b.dueAt.toISOString(),
      daysPastDue: daysOverdue(b.dueAt, now),
      level: b.level,
      acknowledgedAt: b.acknowledgedAt?.toISOString() ?? null,
      snoozedUntil: b.snoozedUntil?.toISOString() ?? null,
    })),
  };
}

/** The owners (mentors) that currently have an open breach — the owner filter's options. */
export async function breachOwners(tenant: TenantWhere): Promise<{ id: string; fullName: string }[]> {
  const rows = await prisma.slaBreach.findMany({
    where: withinTenant({ resolvedAt: null }, tenant),
    select: { relation: { select: { mentor: { select: { id: true, fullName: true } } } } },
  });
  const byId = new Map(rows.map((r) => [r.relation.mentor.id, r.relation.mentor]));
  return Array.from(byId.values()).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export interface SlaComplianceReport extends ComplianceResult {
  from: string;
  to: string;
  days: number;
}

/**
 * The compliance rate over the last `days` days. `orgId` names the service
 * levels and the stage set (an org-less admin reads the built-in catalogue);
 * `tenant` scopes the relations.
 */
export async function slaCompliance(
  orgId: string | null,
  tenant: TenantWhere,
  days: number,
  now: Date = new Date()
): Promise<SlaComplianceReport> {
  const to = now;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  // Every row in every scope (#3204): an org whose only service levels are
  // cohort or mentor overrides still has a compliance rate.
  const [rows, stages] = await Promise.all([orgId ? loadStageSlaRows(orgId) : Promise.resolve([]), resolvePipelineStages(orgId)]);
  if (rows.length === 0) {
    return { met: 0, total: 0, rate: null, byStage: [], from: from.toISOString(), to: to.toISOString(), days };
  }
  // Only relations that moved in the window; their whole history, because a
  // move's start is the move before it.
  const relations = await prisma.mentorshipRelation.findMany({
    where: withinTenant(
      {
        statusChanges: { some: { createdAt: { gte: from, lt: to } } },
        // Re-engagement pool: not stuck, see analytics/aging.
        mentee: { reEngageAt: null },
      },
      tenant
    ),
    select: {
      startDate: true,
      cohortId: true,
      mentorId: true,
      statusChanges: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, createdAt: true } },
    },
  });
  // Each relation is judged against ITS OWN resolved service levels — its
  // CURRENT cohort and mentor (a transfer of a relation with history starts a
  // new relation, #2289, so moves stay with the mentor they happened under).
  // Memoised per
  // scope: one resolution per (cohort, mentor) pair, not per relation.
  const byScope = new Map<string, Map<string, number>>();
  const slasFor = (r: { cohortId?: string | null; mentorId?: string | null }) => {
    const key = `${r.cohortId ?? ''}|${r.mentorId ?? ''}`;
    let hit = byScope.get(key);
    if (!hit) {
      hit = slaDaysByStage(rows, { cohortId: r.cohortId, mentorId: r.mentorId });
      byScope.set(key, hit);
    }
    return hit;
  };
  const result = computeSlaCompliance(relations, slasFor, { from, to }, (key) => stageClockStopped(key, stages));
  return { ...result, from: from.toISOString(), to: to.toISOString(), days };
}
