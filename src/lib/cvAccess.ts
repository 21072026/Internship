import { prisma } from '@/lib/prisma';
import { accessGrantingRelation } from '@/lib/retention';
import { userInCallerOrg } from '@/lib/ownerOrg';

interface SessionUser {
  id: string;
  role: string;
  companyId?: string | null;
  orgId?: string | null;
}

// A CV is accessible to the owner, any admin, a mentor who mentors that user,
// or a company the user has a mentorship relation with.
//
// "Any admin" is an admin of the CV owner's org (#2542): CvFile carries no
// orgId, so the owner's org is resolved and compared (src/lib/ownerOrg.ts).
// Org-less on either side still passes — the single-tenant state.
//
// For mentors and companies the relation must still confer access: ACTIVE, or
// COMPLETED within the post-mentorship window (#854). Before that check existed
// the mentorship's end changed nothing and access was effectively permanent.
export async function canAccessCv(user: SessionUser, targetUserId: string) {
  if (user.id === targetUserId) return true;
  if (user.role === 'ADMIN') return userInCallerOrg(targetUserId, user.orgId);
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
