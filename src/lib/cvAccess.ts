import { prisma } from '@/lib/prisma';
import { accessGrantingRelation } from '@/lib/retention';

interface SessionUser {
  id: string;
  role: string;
  companyId?: string | null;
}

// A CV is accessible to the owner, any admin, a mentor who mentors that user,
// or a company the user has a mentorship relation with.
//
// For mentors and companies the relation must still confer access: ACTIVE, or
// COMPLETED within the post-mentorship window (#854). Before that check existed
// the mentorship's end changed nothing and access was effectively permanent.
export async function canAccessCv(user: SessionUser, targetUserId: string) {
  if (user.id === targetUserId) return true;
  if (user.role === 'ADMIN') return true;
  if (user.role === 'MENTOR') {
    const rel = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: user.id, menteeId: targetUserId, ...accessGrantingRelation() },
      select: { id: true },
    });
    return !!rel;
  }
  if (user.role === 'COMPANY' && user.companyId) {
    const rel = await prisma.mentorshipRelation.findFirst({
      where: { companyId: user.companyId, menteeId: targetUserId, ...accessGrantingRelation() },
      select: { id: true },
    });
    return !!rel;
  }
  return false;
}
