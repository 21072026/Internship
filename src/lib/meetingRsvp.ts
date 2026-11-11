import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';

// The invitee's yes/no on a meeting — the ONE write of `Meeting.rsvp` from an
// answer (#1949). The public token page (POST /api/rsvp) and the chat card's
// Yes/No both call it, so the row, the organiser's bell and its link are the
// same whichever door the answer came in by.
//
// Who may answer is the CALLER's question, answered before this is called: the
// token route by the unguessable token, the chat dispatcher by the verified
// identity being the meeting's invitee.
//
// IDEMPOTENT: the write is guarded on the answer actually changing, so a stale
// card clicked twice, or a page submitted twice, writes once and tells the
// organiser once.

export interface RsvpMeeting {
  id: string;
  title: string;
  createdById: string;
  projectId: string | null;
  conversationId: string | null;
  relation: { menteeId: string } | null;
}

/** Where the organiser's notification opens: the surface the meeting lives on. */
export function rsvpCreatorLink(meeting: RsvpMeeting): string {
  return meeting.projectId
    ? `/projects/${meeting.projectId}`
    : meeting.conversationId
      ? `/messages/c/${meeting.conversationId}`
      : meeting.relation?.menteeId === meeting.createdById
        ? '/portal'
        : '/mentor/meetings';
}

export async function recordMeetingRsvp(meeting: RsvpMeeting, status: 'ACCEPTED' | 'DECLINED'): Promise<'recorded' | 'unchanged'> {
  const changed = await prisma.meeting.updateMany({ where: { id: meeting.id, rsvp: { not: status } }, data: { rsvp: status } });
  if (changed.count === 0) return 'unchanged';
  await notify(meeting.createdById, status === 'ACCEPTED' ? 'rsvp.accepted' : 'rsvp.declined', { title: meeting.title }, rsvpCreatorLink(meeting));
  return 'recorded';
}
