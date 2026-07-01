import { prisma } from '@/lib/prisma';

interface SessionUser {
  id: string;
  role: string;
  companyId?: string | null;
}

// A CV is accessible to the owner, any admin, a mentor who mentors that user,
// or a company the user has a mentorship relation with.
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
  if (user.role === 'COMPANY' && user.companyId) {
    const rel = await prisma.mentorshipRelation.findFirst({
      where: { companyId: user.companyId, menteeId: targetUserId },
      select: { id: true },
    });
    return !!rel;
  }
  return false;
}
