// Loads the pair meetings the cadence figures count (#2014) — server-only. The
// arithmetic is src/lib/meetingCadence.ts.
//
// Counted: a tenant's ACTIVE relations; their Meeting rows that were not
// cancelled and have started, within the gap window; and recurring
// occurrences that have no Meeting row but do have an attendance record (an
// occurrence nobody recorded and the reminder job never materialized is not
// visible to anything here — said plainly in docs/meeting-attendance.md).

import { prisma } from '@/lib/prisma';
import { withinTenant, type TenantWhere } from '@/lib/tenantFilter';
import { GAP_WINDOW_DAYS, programmeAttendance, type PairMeeting, type ProgrammeAttendance } from '@/lib/meetingCadence';

const DAY = 24 * 60 * 60 * 1000;

export async function loadPairMeetings(relationIds: string[], now: Date): Promise<PairMeeting[]> {
  if (relationIds.length === 0) return [];
  const since = new Date(now.getTime() - GAP_WINDOW_DAYS * DAY);
  const [rows, occurrences] = await Promise.all([
    prisma.meeting.findMany({
      where: { relationId: { in: relationIds }, status: { not: 'CANCELLED' }, scheduledAt: { gte: since, lte: now } },
      select: { relationId: true, scheduledAt: true, seriesId: true, attendance: { where: { state: 'NO_SHOW' }, select: { id: true } } },
    }),
    prisma.meetingAttendance.findMany({
      where: { relationId: { in: relationIds }, meetingId: null, seriesId: { not: null }, meetingAt: { gte: since, lte: now } },
      select: { relationId: true, seriesId: true, meetingAt: true, state: true },
    }),
  ]);
  const meetings: PairMeeting[] = rows.map((r) => ({ relationId: r.relationId!, at: r.scheduledAt!, noShow: r.attendance.length > 0 }));
  // An occurrence that also has a Meeting row is that row — count it once.
  const materialized = new Set(rows.filter((r) => r.seriesId).map((r) => `${r.seriesId}|${r.scheduledAt!.getTime()}`));
  const byOccurrence = new Map<string, PairMeeting>();
  for (const a of occurrences) {
    const key = `${a.seriesId}|${a.meetingAt.getTime()}`;
    if (materialized.has(key) || a.state === 'LATE_CANCEL') continue;
    const prev = byOccurrence.get(key);
    byOccurrence.set(key, { relationId: a.relationId!, at: a.meetingAt, noShow: (prev?.noShow ?? false) || a.state === 'NO_SHOW' });
  }
  return [...meetings, ...byOccurrence.values()];
}

export async function loadProgrammeAttendance(tenant: TenantWhere, now = new Date()): Promise<ProgrammeAttendance> {
  const relations = await prisma.mentorshipRelation.findMany({
    where: withinTenant({ status: 'ACTIVE' as const }, tenant),
    select: { id: true, expectedMeetingIntervalWeeks: true },
  });
  const meetings = await loadPairMeetings(relations.map((r) => r.id), now);
  return programmeAttendance(relations.map((r) => ({ relationId: r.id, expectedIntervalWeeks: r.expectedMeetingIntervalWeeks })), meetings, now);
}
