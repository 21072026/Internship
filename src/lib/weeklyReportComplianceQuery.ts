// The Prisma half of weekly-report compliance (#1917): loads what
// src/lib/weeklyReportCompliance.ts computes on. Kept apart from the rule so
// the rule stays pure and unit-testable.
//
// QUERY BUDGET — the point of this file. However many relations a page holds,
// computing them costs exactly TWO queries here: every relevant stage move for
// the whole batch, and every weekly report for the whole batch. No per-relation
// round trip, ever (the N+1 shape #1438 found on /admin).

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  INTERNSHIP_STAGE_KEY,
  complianceForRelation,
  expectedWeeks,
  internshipWindow,
  type Compliance,
  type InternshipWindow,
} from '@/lib/weeklyReportCompliance';

/** Relations that owe weekly reports at all: in the internship stage now, or ever moved into it. */
export const INTERNED_WHERE: Prisma.MentorshipRelationWhereInput = {
  OR: [{ pipelineStatus: INTERNSHIP_STAGE_KEY }, { statusChanges: { some: { toStatus: INTERNSHIP_STAGE_KEY } } }],
};

export const COMPLIANCE_RELATION_SELECT = {
  id: true,
  status: true,
  pipelineStatus: true,
  startDate: true,
  completedAt: true,
  mentee: { select: { id: true, fullName: true } },
  mentor: { select: { id: true, fullName: true } },
  company: { select: { id: true, name: true } },
  cohort: { select: { id: true, name: true } },
} satisfies Prisma.MentorshipRelationSelect;

export type ComplianceRelation = Prisma.MentorshipRelationGetPayload<{ select: typeof COMPLIANCE_RELATION_SELECT }>;

export interface ComplianceRow {
  relation: ComplianceRelation;
  window: InternshipWindow | null;
  compliance: Compliance;
  /** The most recent first hand-in among this relation's reports (any week). */
  lastSubmittedAt: Date | null;
}

export type ReportingRange = { from?: Date | null; to?: Date | null };

/** Compute every relation of a batch in two queries. */
export async function complianceRows(relations: ComplianceRelation[], now: Date, range: ReportingRange = {}): Promise<ComplianceRow[]> {
  if (relations.length === 0) return [];
  const ids = relations.map((r) => r.id);
  const [changes, reports] = await Promise.all([
    prisma.statusChange.findMany({
      where: { relationId: { in: ids }, OR: [{ toStatus: INTERNSHIP_STAGE_KEY }, { fromStatus: INTERNSHIP_STAGE_KEY }] },
      select: { relationId: true, fromStatus: true, toStatus: true, createdAt: true },
    }),
    prisma.weeklyReport.findMany({
      where: { relationId: { in: ids } },
      select: { relationId: true, weekStart: true, status: true, submittedAt: true },
    }),
  ]);
  const group = <T extends { relationId: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.relationId, [...(map.get(row.relationId) ?? []), row]);
    return map;
  };
  const changesBy = group(changes);
  const reportsBy = group(reports);

  return relations.map((relation) => {
    const window = internshipWindow({ ...relation, changes: changesBy.get(relation.id) ?? [] });
    const own = reportsBy.get(relation.id) ?? [];
    const compliance = complianceForRelation({ expected: expectedWeeks(window, now, range), reports: own });
    const lastSubmittedAt = own.reduce<Date | null>(
      (latest, r) => (r.submittedAt && (!latest || r.submittedAt > latest) ? r.submittedAt : latest),
      null
    );
    return { relation, window, compliance, lastSubmittedAt };
  });
}
