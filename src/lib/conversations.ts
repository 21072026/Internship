import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getThreadIfAllowed } from '@/lib/messaging';

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

export async function isActiveProjectMember(userId: string, projectId: string): Promise<boolean> {
  if (!userId || !projectId) return false;
  return (await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { id: true },
  })) !== null;
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
  if (conversation.type === 'GROUP') {
    if (!conversation.projectId || !isParticipant) return null;
    return (await isActiveProjectMember(user.id, conversation.projectId)) ? conversation : null;
  }
  if (!isParticipant && user.role !== 'ADMIN') return null;
  return conversation;
}

// The participants to notify when someone posts to a conversation (everyone but
// the sender). The conversation-layer counterpart of otherParticipant().
export async function otherConversationParticipants(
  conversation: { type?: string; projectId?: string | null; participants: { userId: string }[] },
  senderId: string,
): Promise<string[]> {
  const participantIds = [...new Set(conversation.participants.map((p) => p.userId))].filter((id) => id !== senderId);
  if (conversation.type !== 'GROUP' || !conversation.projectId || participantIds.length === 0) return participantIds;
  const activeMembers = await prisma.projectMember.findMany({
    where: { projectId: conversation.projectId, userId: { in: participantIds } },
    select: { userId: true },
  });
  return activeMembers.map((member) => member.userId);
}

// The unique identity of a DIRECT conversation between two users: their ids
// sorted, so the pair maps to one key regardless of who starts the chat.
export function directKeyFor(userAId: string, userBId: string): string {
  return [userAId, userBId].sort().join('|');
}

const CONVERSATION_INCLUDE = {
  participants: {
    select: { userId: true, lastReadAt: true, user: { select: { id: true, fullName: true } } },
  },
} as const;

// Create-or-get the 1:1 conversation between two users (#769).
// Returns null when the pair isn't allowed to message each other — the caller
// turns that into a 403. Authorization is checked HERE so no route can skip it.
//
// Concurrency: the pair's identity lives in the unique `directKey` column, so
// two simultaneous requests can't produce two conversations for the same pair —
// the loser of the race gets a unique-constraint violation and reads the winner's
// row instead. Matching on `directKey` (rather than scanning participants) also
// means a GROUP conversation, or a conversation that happens to include both
// users plus a third, can never be returned by mistake.
export async function findOrCreateDirectConversation(userAId: string, userBId: string) {
  if (!(await canMessage(userAId, userBId))) return null;

  const key = directKeyFor(userAId, userBId);
  const existing = await prisma.conversation.findUnique({
    where: { directKey: key },
    include: CONVERSATION_INCLUDE,
  });
  if (existing) return existing;

  try {
    return await prisma.conversation.create({
      data: {
        type: 'DIRECT',
        directKey: key,
        participants: { create: [{ userId: userAId }, { userId: userBId }] },
      },
      include: CONVERSATION_INCLUDE,
    });
  } catch (e) {
    // Lost the race — the other request created it microseconds earlier.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return prisma.conversation.findUnique({ where: { directKey: key }, include: CONVERSATION_INCLUDE });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// One 1:1 thread per pair (#1156).
//
// A 1:1 chat grew two parallel homes: the original mentorship thread
// (Message.relationId, /messages/<relationId>) and the conversation layer
// (Message.conversationId, /messages/c/<id>). A mentor who wrote from the mentee
// page and again from a user card ended up with the same person twice in the
// inbox, each row holding half the history.
//
// The DIRECT conversation is now the single home for a 1:1 thread. A mentorship's
// messages are adopted into it on first touch, and new messages keep their
// relationId as an annotation, so everything that reads a thread through the
// mentorship — reply-by-email tokens, the unread digest, the onboarding
// checklist — keeps working off it.
// ---------------------------------------------------------------------------

// The pair's mentorship, if any; the most recently started one when a pair has
// several (nothing stops an admin from assigning the same mentee twice). Used to
// stamp a new conversation message so it stays visible to the mentorship-scoped
// features, and to tell a 1:1 thread which side of it is the mentor.
export async function latestMentorshipFor(
  userAId: string,
  userBId: string,
): Promise<{ id: string; mentorId: string } | null> {
  if (!userAId || !userBId || userAId === userBId) return null;
  return prisma.mentorshipRelation.findFirst({
    where: {
      OR: [
        { mentorId: userAId, menteeId: userBId },
        { mentorId: userBId, menteeId: userAId },
      ],
    },
    orderBy: { startDate: 'desc' },
    select: { id: true, mentorId: true },
  });
}

// The other side of a 1:1 conversation, from the viewer's seat.
export function directCounterpartId(
  conversation: { type: string; participants: { userId: string }[] },
  userId: string,
): string | null {
  if (conversation.type !== 'DIRECT') return null;
  return conversation.participants.map((p) => p.userId).find((id) => id !== userId) ?? null;
}

// The conversation that holds a mentorship's 1:1 thread, creating it on first
// use and pulling the relation's own messages in with it.
//
// No canMessage() check: a mentorship IS permission to message (see
// hasMentorship above), so re-deriving it here would only cost queries on a page
// that resolves one of these per mentee. The adoption is a single indexed UPDATE
// and idempotent — messages already carrying a conversationId are left alone, so
// this is safe to call on every page load.
export async function conversationForRelation(relation: { id: string; mentorId: string; menteeId: string }) {
  const key = directKeyFor(relation.mentorId, relation.menteeId);
  let conversation = await prisma.conversation.findUnique({ where: { directKey: key }, include: CONVERSATION_INCLUDE });
  if (!conversation) {
    try {
      conversation = await prisma.conversation.create({
        data: {
          type: 'DIRECT',
          directKey: key,
          participants: { create: [{ userId: relation.mentorId }, { userId: relation.menteeId }] },
        },
        include: CONVERSATION_INCLUDE,
      });
    } catch (e) {
      // Lost the race with another request (or a second relation for the same
      // pair, resolved in parallel) — read the winner's row.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      conversation = await prisma.conversation.findUnique({ where: { directKey: key }, include: CONVERSATION_INCLUDE });
    }
  }
  if (!conversation) return null;
  await prisma.message.updateMany({
    where: { relationId: relation.id, conversationId: null },
    data: { conversationId: conversation.id },
  });
  return conversation;
}

// Creates the project's single GROUP conversation on first use and reconciles
// all current ProjectMember rows into its participant list. The compound unique
// key keeps concurrent callers idempotent at database level.
export async function createOrGetProjectConversation(projectId: string) {
  if (!projectId) return null;
  const memberIds = await projectMemberIds(projectId);
  try {
    return await prisma.conversation.upsert({
      where: { type_projectId: { type: 'GROUP', projectId } },
      update: memberIds.length
        ? { participants: { createMany: { data: memberIds.map((userId) => ({ userId })), skipDuplicates: true } } }
        : {},
      create: {
        type: 'GROUP',
        projectId,
        ...(memberIds.length ? { participants: { create: memberIds.map((userId) => ({ userId })) } } : {}),
      },
      include: CONVERSATION_INCLUDE,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.conversation.findUnique({
        where: { type_projectId: { type: 'GROUP', projectId } },
        include: CONVERSATION_INCLUDE,
      });
    }
    throw error;
  }
}

export async function removeProjectConversationParticipant(projectId: string, userId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { type_projectId: { type: 'GROUP', projectId } },
    select: { id: true },
  });
  if (!conversation) return;
  await prisma.conversationParticipant.deleteMany({
    where: { conversationId: conversation.id, userId },
  });
}

// May this user still POST into this conversation? (#770)
//
// Reading is participant-based and permanent — conversation history stays
// visible to the people who were in it. Writing is re-checked against the
// live permission, so someone removed from the shared project can no longer
// send new messages into a DM that project membership originally unlocked.
// GROUP conversations are governed by their own membership, so participation
// is the rule there.
export async function canPostToConversation(
  user: SessionUser,
  conversation: { id: string; type: string; projectId?: string | null; participants: { userId: string }[] },
): Promise<boolean> {
  // An admin viewing someone else's conversation isn't a participant and has
  // nothing to post; participants are what matter here.
  if (!conversation.participants.some((p) => p.userId === user.id)) return false;
  if (conversation.type === 'GROUP') {
    return Boolean(conversation.projectId && (await isActiveProjectMember(user.id, conversation.projectId)));
  }
  if (conversation.type !== 'DIRECT') return false;
  const others = await otherConversationParticipants(conversation, user.id);
  const other = others[0];
  if (!other) return false;
  return canMessage(user.id, other);
}

// May this user act on this message? A message belongs to a mentorship thread
// (legacy `relationId`), a conversation (`conversationId`), or — in principle —
// both. Authorization follows whichever link it has, so the message/reaction/
// attachment sub-routes work identically on both paths. A message with neither
// link is unreachable (fail closed).
export async function canAccessMessage(
  user: SessionUser,
  message: { relationId: string | null; conversationId: string | null },
): Promise<boolean> {
  if (message.relationId && (await getThreadIfAllowed(user, message.relationId))) return true;
  if (message.conversationId && (await getConversationIfAllowed(user, message.conversationId))) return true;
  return false;
}
