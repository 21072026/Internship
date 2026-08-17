import { prisma } from '@/lib/prisma';

// "Were you in this meeting, or did you call it?" — the one rule that governs a
// meeting row, wherever it is reached from.
//
// It was written for notes (#1056, `canAttachNoteToMeeting`, which now delegates
// here) and the call-token endpoint (#1237) needs exactly the same answer before
// it will sign anything: a token is scoped to a room, so handing one to a
// stranger is handing them the call.

export interface AccessibleMeeting {
  id: string;
  title: string;
  meetLink: string | null;
  createdById: string;
  /** True for the person who called the meeting (and for an admin). */
  organizer: boolean;
}

// Returns the meeting when this user may take part in it, null otherwise —
// including when it does not exist, so a probe cannot tell the two apart.
export async function loadAccessibleMeeting(
  user: { id: string; role: string },
  meetingId: string
): Promise<AccessibleMeeting | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      title: true,
      meetLink: true,
      createdById: true,
      relation: { select: { mentorId: true, menteeId: true } },
      projectId: true,
      conversationId: true,
    },
  });
  if (!meeting) return null;

  const isAdmin = user.role === 'ADMIN';
  const isCreator = meeting.createdById === user.id;
  const found = {
    id: meeting.id,
    title: meeting.title,
    meetLink: meeting.meetLink,
    createdById: meeting.createdById,
    organizer: isCreator || isAdmin,
  };

  if (isCreator || isAdmin) return found;
  if (meeting.relation && (meeting.relation.mentorId === user.id || meeting.relation.menteeId === user.id)) {
    return found;
  }
  if (meeting.projectId) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: meeting.projectId, userId: user.id } },
      select: { id: true },
    });
    if (member) return found;
  }
  if (meeting.conversationId) {
    const participant = await prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: meeting.conversationId, userId: user.id } },
      select: { id: true },
    });
    if (participant) return found;
  }
  return null;
}

export async function canAccessMeeting(
  user: { id: string; role: string },
  meetingId: string
): Promise<boolean> {
  return (await loadAccessibleMeeting(user, meetingId)) !== null;
}
