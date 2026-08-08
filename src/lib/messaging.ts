import { prisma } from '@/lib/prisma';

interface SessionUser {
  id: string;
  role: string;
}

// A mentorship thread is accessible to its mentor, its mentee, or any admin.
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
  const isParticipant = rel.mentorId === user.id || rel.menteeId === user.id;
  if (!isParticipant && user.role !== 'ADMIN') return null;
  return rel;
}

// The "other" participant to notify when someone posts to a thread.
export function otherParticipant(rel: { mentorId: string; menteeId: string }, senderId: string) {
  return senderId === rel.mentorId ? rel.menteeId : rel.mentorId;
}
