import { prisma } from '@/lib/prisma';
import { accessGrantingRelation } from '@/lib/retention';
import { userInCallerOrg } from '@/lib/ownerOrg';

interface SessionUser {
  id: string;
  role: string;
  orgId?: string | null;
}

// A user's documents are accessible to the owner, an admin of the owner's org,
// or a mentor who mentors that user. (Same rule as CVs — including the
// post-mentorship access window, #854: the relation must be ACTIVE or recently
// COMPLETED.) "Any admin" used to mean any tenant's admin (#2542); an org-less
// admin or owner still passes, which is the single-tenant state. The routes
// check the org first themselves so a foreign owner reads as 404; this is the
// backstop for any caller that does not.
export async function canAccessUserDocs(user: SessionUser, ownerId: string) {
  if (user.id === ownerId) return true;
  if (user.role === 'ADMIN') return userInCallerOrg(ownerId, user.orgId);
  if (user.role === 'MENTOR') {
    const rel = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: user.id, menteeId: ownerId, ...accessGrantingRelation() },
      select: { id: true },
    });
    return !!rel;
  }
  return false;
}

export const DOCUMENT_TYPES = ['CV', 'CONTRACT', 'CERTIFICATE', 'OTHER'] as const;

export const ALLOWED_DOC_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
]);

export const MAX_DOC_BYTES = 10 * 1024 * 1024; // 10 MB
