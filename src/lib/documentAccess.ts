import { prisma } from '@/lib/prisma';
import { accessGrantingRelation } from '@/lib/retention';

interface SessionUser {
  id: string;
  role: string;
}

// A user's documents are accessible to the owner, any admin, or a mentor who
// mentors that user. (Same rule as CVs — including the post-mentorship access
// window, #854: the relation must be ACTIVE or recently COMPLETED.)
export async function canAccessUserDocs(user: SessionUser, ownerId: string) {
  if (user.id === ownerId) return true;
  if (user.role === 'ADMIN') return true;
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
