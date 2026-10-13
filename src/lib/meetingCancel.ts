// The ONE way a scheduled meeting is called off (#1980, #1844): the status
// flip, the late-cancel attendance record and the withdrawal from every
// connected Google calendar, together. PATCH /api/meetings/[id] and the
// interview-request cancel route both run through here, so a cancelled
// meeting can never be a ghost on somebody's real calendar — the failure the
// integration cannot survive. The row itself is never deleted: the notes and
// the interaction log written in it keep their anchor.
import { prisma } from '@/lib/prisma';
import { recordLateCancel } from '@/lib/meetingAttendance';
import { withdrawMeetings } from '@/lib/googleCalendarSync';

export async function cancelMeetingRows(params: {
  ids: string[];
  actorId: string;
  reason: string | null;
  now?: Date;
}): Promise<void> {
  const { ids, actorId } = params;
  if (ids.length === 0) return;
  const now = params.now ?? new Date();
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
}
