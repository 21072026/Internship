// Relationship health, scored NOW (#1901, #1902) — the one place that loads a
// batch of relations' signals and runs them through the published rules table
// (src/lib/relationHealth.ts). The nightly sweep and the admin monitor both
// call it, so the snapshot a sweep writes at 02:00 and the score an admin sees
// at 14:00 are the same computation over fresher data, never two readings of
// "what a signal means".
//
// Server-only (Prisma). The caller owns the WHERE: the sweep passes an org list
// it was handed, the admin route its own tenant filter.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { findDormantFirstContacts } from '@/lib/dormantFirstContact';
import { getLastContacts } from '@/lib/lastContact';
import { menteesWithOpenTodo } from '@/lib/openWork';
import { SUBMITTED_WEEKLY_REPORT_STATUSES } from '@/lib/weeklyReports';
import { scoreRelation, type HealthAssessment } from '@/lib/relationHealth';

export const HEALTH_RELATION_SELECT = {
  id: true,
  orgId: true,
  status: true,
  pipelineStatus: true,
  startDate: true,
  stageDeadline: true,
  cohortId: true,
  mentor: { select: { id: true, fullName: true, isActive: true } },
  mentee: { select: { id: true, fullName: true } },
  questions: { where: { answer: null }, select: { id: true } },
  meetingRequests: { where: { status: 'PENDING' as const }, select: { id: true } },
  goals: { where: { status: 'OPEN' as const }, select: { id: true } },
  weeklyReports: { where: { status: { in: [...SUBMITTED_WEEKLY_REPORT_STATUSES] } }, select: { weekStart: true } },
} satisfies Prisma.MentorshipRelationSelect;

export type HealthRelationRow = Prisma.MentorshipRelationGetPayload<{ select: typeof HEALTH_RELATION_SELECT }>;

export interface AssessedRelation {
  row: HealthRelationRow;
  assessment: HealthAssessment;
  lastContactAt: Date | null;
}

/** `reminderDays` per org, read once per pass — it is a setting, never a constant. */
export function reminderDaysReader() {
  const cache = new Map<string, Promise<number>>();
  return (orgId: string | null) => {
    const key = orgId ?? '';
    if (!cache.has(key)) cache.set(key, getSetting('reminderDays', orgId ?? undefined).then((v) => parseInt(v, 10) || 14));
    return cache.get(key)!;
  };
}

/** Score one batch of loaded relations. Keep batches bounded (the sweep uses 500). */
export async function assessRelations(
  rows: HealthRelationRow[],
  now: Date,
  reminderDaysFor: (orgId: string | null) => Promise<number>,
): Promise<AssessedRelation[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [openWork, dormant, lastContacts, lastMoves] = await Promise.all([
    menteesWithOpenTodo(rows.map((r) => r.mentee.id)),
    findDormantFirstContacts(rows.map((r) => ({ id: r.id, orgId: r.orgId, menteeId: r.mentee.id, pipelineStatus: r.pipelineStatus, stageDeadline: r.stageDeadline }))),
    getLastContacts(rows.map((r) => ({ id: r.id, menteeId: r.mentee.id }))),
    prisma.statusChange.groupBy({ by: ['relationId'], where: { relationId: { in: ids } }, _max: { createdAt: true } }),
  ]);
  const lastMoveBy = new Map(lastMoves.map((m) => [m.relationId, m._max.createdAt]));

  const out: AssessedRelation[] = [];
  for (const r of rows) {
    const lastContactAt = lastContacts.get(r.id)?.at ?? null;
    const assessment = scoreRelation({
      now: now.getTime(),
      reminderDays: await reminderDaysFor(r.orgId),
      status: r.status,
      dormant: dormant.has(r.id),
      startDate: r.startDate,
      lastContactAt,
      stageDeadline: r.stageDeadline,
      unansweredQuestions: r.questions.length,
      pendingMeetingRequests: r.meetingRequests.length,
      hasOpenWork: r.goals.length > 0 || openWork.has(r.mentee.id),
      weeklyReports:
        r.pipelineStatus === 'INTERNSHIP_IN_PROGRESS_450'
          ? { submittedWeekStarts: r.weeklyReports.map((w) => w.weekStart.getTime()) }
          : null,
      lastStageMoveAt: lastMoveBy.get(r.id) ?? null,
    });
    out.push({ row: r, assessment, lastContactAt });
  }
  return out;
}
