import { prisma } from '@/lib/prisma';

// May this user attach a note to this meeting (#1056)?
//
// Without the check, any note could carry any meeting id: the note itself stays
// private, but the id is a foreign key into someone else's meeting and
// `GET /api/notes?meetingId=` would happily confirm it exists. So the rule is
// the same one that governs the meeting: you were in it, or you called it.
export async function canAttachNoteToMeeting(
  user: { id: string; role: string },
  meetingId: string
): Promise<boolean> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      createdById: true,
      relation: { select: { mentorId: true, menteeId: true } },
      projectId: true,
      conversationId: true,
    },
  });
  if (!meeting) return false;
  if (meeting.createdById === user.id) return true;
  if (user.role === 'ADMIN') return true;
  if (meeting.relation && (meeting.relation.mentorId === user.id || meeting.relation.menteeId === user.id)) {
    return true;
  }
  if (meeting.projectId) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: meeting.projectId, userId: user.id } },
      select: { id: true },
    });
    if (member) return true;
  }
  if (meeting.conversationId) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: meeting.conversationId, userId: user.id } },
      select: { id: true },
    });
    if (participant) return true;
  }
  return false;
}
