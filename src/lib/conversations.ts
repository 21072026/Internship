import { prisma } from '@/lib/prisma';

interface SessionUser {
  id: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Server-side messaging authorization (#768).
//
// Who a user may message is decided HERE, on the server — never by the UI alone.
// Two independent sources of permission:
//   1. project membership — both users are members of the same project;
//   2. mentorship        — a MentorshipRelation links them (mentor ↔ mentee).
// Mentorship stays an ADDITIONAL source, so the pre-existing mentorship
// messaging path (getThreadIfAllowed in src/lib/messaging.ts) is unaffected.
// ---------------------------------------------------------------------------

// Every userId that is a member of a project. ProjectMember is the canonical
// membership table (#617/#619) and covers OWNER, MENTOR and MENTEE members
// alike, so this is the full roster of people who "are in" the project.
export async function projectMemberIds(projectId: string): Promise<string[]> {
  if (!projectId) return [];
  const rows = await prisma.projectMember.findMany({
    where: { projectId },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

// Do these two users share at least one project? Resolved in a single query via
// a relation filter (a member row for A on a project that also has a member row
// for B).
export async function sharesProject(userAId: string, userBId: string): Promise<boolean> {
  if (!userAId || !userBId || userAId === userBId) return false;
  const hit = await prisma.projectMember.findFirst({
    where: { userId: userAId, project: { members: { some: { userId: userBId } } } },
    select: { id: true },
  });
  return hit !== null;
}

// Is there a mentorship between these two users, in either direction? Any
// relation counts (including COMPLETED ones) — the mentorship thread stays
// readable after the mentorship ends, and this must not be stricter than the
// existing getThreadIfAllowed behaviour.
export async function hasMentorship(userAId: string, userBId: string): Promise<boolean> {
  if (!userAId || !userBId || userAId === userBId) return false;
  const hit = await prisma.mentorshipRelation.findFirst({
    where: {
      OR: [
        { mentorId: userAId, menteeId: userBId },
        { mentorId: userBId, menteeId: userAId },
      ],
    },
    select: { id: true },
  });
  return hit !== null;
}

// May user A and user B exchange messages?
//   true  — they are members of the same project, OR a mentorship links them,
//           OR either of them is an ADMIN (admins can reach anyone, mirroring
//           the admin bypass in getThreadIfAllowed).
//   false — no shared project and no mentorship (unrelated users), or either id
//           does not resolve to a user.
// Self-messaging is not a thing, so a === b is false.
export async function canMessage(userAId: string, userBId: string): Promise<boolean> {
  if (!userAId || !userBId || userAId === userBId) return false;

  const users = await prisma.user.findMany({
    where: { id: { in: [userAId, userBId] } },
    select: { id: true, role: true },
  });
  // Both ids must resolve to real users.
  if (!users.some((u) => u.id === userAId) || !users.some((u) => u.id === userBId)) return false;
  if (users.some((u) => u.role === 'ADMIN')) return true;

  if (await sharesProject(userAId, userBId)) return true;
  return hasMentorship(userAId, userBId);
}

// Filter a list of candidate userIds down to the ones the given user may
// message. Used by "start a conversation" pickers so the server, not the client,
// decides the allowed set.
export async function messageableUserIds(userId: string, candidateIds: string[]): Promise<string[]> {
  const unique = [...new Set(candidateIds)].filter((id) => id && id !== userId);
  if (unique.length === 0) return [];
  const results = await Promise.all(unique.map(async (id) => ((await canMessage(userId, id)) ? id : null)));
  return results.filter((id): id is string => id !== null);
}

// A conversation is accessible to its participants, or to any admin.
// Returns the conversation (with participant ids) when allowed, else null.
export async function getConversationIfAllowed(user: SessionUser, conversationId: string) {
  if (!conversationId) return null;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      participants: {
        select: {
          userId: true,
          lastReadAt: true,
          user: { select: { id: true, fullName: true } },
        },
      },
    },
  });
  if (!conversation) return null;
  const isParticipant = conversation.participants.some((p) => p.userId === user.id);
  if (!isParticipant && user.role !== 'ADMIN') return null;
  return conversation;
}

// The participants to notify when someone posts to a conversation (everyone but
// the sender). The conversation-layer counterpart of otherParticipant().
export function otherConversationParticipants(
  conversation: { participants: { userId: string }[] },
  senderId: string,
): string[] {
  return [...new Set(conversation.participants.map((p) => p.userId))].filter((id) => id !== senderId);
}
