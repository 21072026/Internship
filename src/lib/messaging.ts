import { prisma } from '@/lib/prisma';

interface SessionUser {
  id: string;
  role: string;
}

// A mentorship thread is accessible to its mentor, its mentee, or any admin.
// Returns the relation (with participant ids/names) when allowed, else null.
export async function getThreadIfAllowed(user: SessionUser, relationId: string) {
  const rel = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    include: {
      mentor: { select: { id: true, fullName: true } },
      mentee: { select: { id: true, fullName: true } },
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
