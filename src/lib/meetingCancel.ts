// The ONE way a scheduled meeting is called off (#1980, #1844): the status
// flip, the late-cancel attendance record and the withdrawal from every
// connected Google calendar, together. PATCH /api/meetings/[id] and the
// interview-request cancel route both run through here, so a cancelled
// meeting can never be a ghost on somebody's real calendar — the failure the
// integration cannot survive. The row itself is never deleted: the notes and
// the interaction log written in it keep their anchor. And it raises the one
// `meeting.cancelled` (#1998) — so neither caller can forget it.
import { prisma } from '@/lib/prisma';
import { emit } from '@/lib/events/emit';
import { recordLateCancel } from '@/lib/meetingAttendance';
import { withdrawMeetings } from '@/lib/googleCalendarSync';

export async function cancelMeetingRows(params: {
  ids: string[];
  actorId: string;
  reason: string | null;
  now?: Date;
  /** The tenant the event is recorded under (both callers know it). */
  orgId: string | null;
  /** The row the actor addressed; a batch is one event about it. Default: the first id. */
  subjectId?: string;
}): Promise<void> {
  const { ids, actorId } = params;
  if (ids.length === 0) return;
  const now = params.now ?? new Date();
  const subjectId = params.subjectId ?? ids[0];
  const subject = await prisma.meeting.findUnique({ where: { id: subjectId }, select: { scheduledAt: true } });
  await prisma.meeting.updateMany({
    where: { id: { in: ids } },
    data: {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelledById: actorId,
      cancelReason: params.reason?.trim() || null,
    },
  });
  // Cancelled inside the late-cancel window by one of the pair: that is a
  // LATE_CANCEL for them (#2014) — derived here, never typed by anyone.
  await recordLateCancel(
    await prisma.meeting.findMany({
      where: { id: { in: ids } },
      select: { id: true, scheduledAt: true, relation: { select: { id: true, orgId: true, mentorId: true, menteeId: true } } },
    }),
    actorId,
    now,
  );
  // Off the invitees' real calendars too — through the helper, never by
  // deleting GoogleCalendarEventLink rows from here (#1986 owns that file).
  await withdrawMeetings(ids);
  // One event per call — "a meeting, or `count` meetings of one batch". The
  // reason stays off the bus: free text, and somebody's own words.
  await emit(
    'meeting.cancelled',
    { meetingId: subjectId, scheduledAt: subject?.scheduledAt?.toISOString() ?? null, count: ids.length },
    { orgId: params.orgId, actor: { id: actorId, type: 'user' } },
  );
}
