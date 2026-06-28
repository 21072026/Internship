import { prisma } from '@/lib/prisma';

interface SessionUser {
  id: string;
  role: string;
}

// A CV is accessible to the owner, any admin, or a mentor who mentors that user.
export async function canAccessCv(user: SessionUser, targetUserId: string) {
  if (user.id === targetUserId) return true;
  if (user.role === 'ADMIN') return true;
  if (user.role === 'MENTOR') {
    const rel = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: user.id, menteeId: targetUserId },
      select: { id: true },
    });
    return !!rel;
  }
  return false;
}
