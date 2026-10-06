// The programme health scorecard's counts (#1908). Each metric is a count the
// customer can check, loaded for the caller's tenant; the judgement (bands,
// targets, next actions) is src/lib/programScorecard.ts. docs/program-scorecard.md
// is the human-readable copy of both.

import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { assessRelations, HEALTH_RELATION_SELECT, reminderDaysReader } from '@/lib/relationHealthLive';
import { buildScorecard, medianOf, percentOf, type ScorecardMetric, type ScorecardRow, SCORECARD_THRESHOLDS } from '@/lib/programScorecard';

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 500;
/** How far back activation and time-to-first-meeting look. */
const INVITE_WINDOW_DAYS = 90;
const FIRST_MEETING_WINDOW_DAYS = 180;
const CADENCE_DAYS = 30;
const STALL_DAYS = 60;

type Metrics = Partial<Record<keyof typeof SCORECARD_THRESHOLDS, ScorecardMetric>>;

export async function loadProgramScorecard(tenant: TenantWhere, now = new Date()): Promise<ScorecardRow[]> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const active = withinTenant({ status: 'ACTIVE' as const }, tenant);
  const metrics: Metrics = {};

  // Activation — invitations sent in the window whose outcome is known: used,
  // or expired unused. One still open is in flight, not a failure.
  const invites = await prisma.invitationToken.findMany({
    where: withinTenant({ createdAt: { gte: ago(INVITE_WINDOW_DAYS) }, OR: [{ used: true }, { expiresAt: { lt: now } }] }, tenant),
    select: { used: true },
  });
  metrics.activation = { value: percentOf(invites.filter((i) => i.used).length, invites.length), basis: invites.length };

  // Match rate — active mentee accounts that have an active mentor.
  const [mentees, matched] = await Promise.all([
    prisma.user.count({ where: withinTenant({ role: 'MENTEE' as const, isActive: true }, tenant) }),
    prisma.user.count({ where: withinTenant({ role: 'MENTEE' as const, isActive: true, menteeRelations: { some: { status: 'ACTIVE' as const } } }, tenant) }),
  ]);
  metrics.matchRate = { value: percentOf(matched, mentees), basis: mentees };

  // Time to first meeting — relationships started in the window that have
  // met: the median days from start to the first meeting that was not
  // cancelled. A pair that has not met yet is not in the median (it has no
  // number to contribute); a long wait shows up in meeting cadence instead.
  const recent = await prisma.mentorshipRelation.findMany({
    where: withinTenant({ startDate: { gte: ago(FIRST_MEETING_WINDOW_DAYS) } }, tenant),
    select: { id: true, startDate: true },
  });
  const firstMeetings = recent.length
    ? await prisma.meeting.groupBy({
        by: ['relationId'],
        where: { relationId: { in: recent.map((r) => r.id) }, status: 'SCHEDULED', scheduledAt: { not: null, lte: now } },
        _min: { scheduledAt: true },
      })
    : [];
  const startOf = new Map(recent.map((r) => [r.id, r.startDate]));
  const waits = firstMeetings.flatMap((m) => {
    const start = m.relationId ? startOf.get(m.relationId) : undefined;
    const at = m._min.scheduledAt;
    return start && at ? [Math.max(0, Math.floor((at.getTime() - start.getTime()) / DAY))] : [];
  });
  metrics.timeToFirstMeeting = { value: medianOf(waits), basis: waits.length };

  // Meeting cadence — active relationships older than the cadence window with
  // a (not cancelled) meeting inside it.
  const established = await prisma.mentorshipRelation.findMany({
    where: withinTenant({ status: 'ACTIVE' as const, startDate: { lt: ago(CADENCE_DAYS) } }, tenant),
    select: { id: true },
  });
  const met = established.length
    ? await prisma.meeting.groupBy({
        by: ['relationId'],
        where: { relationId: { in: established.map((r) => r.id) }, status: 'SCHEDULED', scheduledAt: { gte: ago(CADENCE_DAYS), lte: now } },
      })
    : [];
  metrics.meetingCadence = { value: percentOf(met.length, established.length), basis: established.length };

  // Stalled pairs — active relationships older than the window with no stage
  // change inside it (the health table's `stage_movement` rule).
  const old = await prisma.mentorshipRelation.findMany({
    where: withinTenant({ status: 'ACTIVE' as const, startDate: { lt: ago(STALL_DAYS) } }, tenant),
    select: { id: true },
  });
  const moved = old.length
    ? await prisma.statusChange.groupBy({ by: ['relationId'], where: { relationId: { in: old.map((r) => r.id) }, createdAt: { gte: ago(STALL_DAYS) } } })
    : [];
  metrics.stalledPairs = { value: percentOf(old.length - moved.length, old.length), basis: old.length };

  // At-risk relationships — scored now with the published health rules, the
  // same computation as /admin/health and the nightly snapshots. Dormant first
  // contacts are not scored, so they are not in the denominator either.
  const reminderDaysFor = reminderDaysReader();
  let scored = 0;
  let atRisk = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.mentorshipRelation.findMany({
      where: active,
      select: HEALTH_RELATION_SELECT,
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const a of await assessRelations(rows, now, reminderDaysFor)) {
      if (a.assessment.excluded) continue;
      scored++;
      if (a.assessment.band === 'AT_RISK') atRisk++;
    }
  }
  metrics.atRisk = { value: percentOf(atRisk, scored), basis: scored };

  return buildScorecard(metrics);
}
