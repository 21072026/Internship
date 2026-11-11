import { prisma } from '@/lib/prisma';
import { isParticipant, memberIdsOf } from '@/lib/relationParticipants';

interface SessionUser {
  id: string;
  role: string;
}

// A mentorship thread is accessible to its mentor, its mentee, any other
// current member of a group relation (#1804), or any admin.
// Returns the relation (with participant ids/names) when allowed, else null.
// `relationId` is nullable since #768 made Message.relationId nullable: a
// conversation-only message has no mentorship thread, so it is never reachable
// through this (legacy) path — fail closed. Conversation-layer authorization
// lives in src/lib/conversations.ts.
export async function getThreadIfAllowed(user: SessionUser, relationId: string | null | undefined) {
  if (!relationId) return null;
  const rel = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    include: {
      // preferredLanguage rides along so the thread header can say which
      // language the other side reads before you start typing (#1164).
      mentor: { select: { id: true, fullName: true, preferredLanguage: true } },
      mentee: { select: { id: true, fullName: true, preferredLanguage: true } },
    },
  });
  if (!rel) return null;
  // The pair, or a seat beyond it (#1804): a group's members share one thread.
  if (user.role !== 'ADMIN' && !(await isParticipant(rel, user.id))) return null;
  return rel;
}

// The "other" participant to notify when someone posts to a thread.
export function otherParticipant(rel: { mentorId: string; menteeId: string }, senderId: string) {
  return senderId === rel.mentorId ? rel.menteeId : rel.mentorId;
}

// Everyone a post to a relation thread reaches (#1804): every current member
// but the sender — for a one-to-one exactly `otherParticipant`, for a group the
// pair and every open seat. An admin posting into a pair's thread reaches both.
export async function threadRecipients(rel: { id: string; mentorId: string; menteeId: string }, senderId: string): Promise<string[]> {
  const members = await memberIdsOf(rel);
  members.delete(senderId);
  return [...members];
}
