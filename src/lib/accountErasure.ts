import { prisma } from '@/lib/prisma';

// Shared erasure logic (EPIC: GDPR data retention). Two modes:
// - hardDeleteUser: same cascade cleanup as the existing self-service account
//   deletion (src/app/api/account/route.ts DELETE) — rows without a DB-level
//   cascade must be removed explicitly before the user row itself.
// - anonymizeUser: keeps the row (and its relations/audit trail intact for
//   analytics) but scrubs PII and removes uploaded file bytes. Preferred when
//   the candidate's history should stay visible to the org.

export async function hardDeleteUser(userId: string): Promise<void> {
  await prisma.mentorshipRelation.deleteMany({ where: { OR: [{ mentorId: userId }, { menteeId: userId }] } });
  await prisma.statusChange.deleteMany({ where: { changedById: userId } });
  // Optional references without a DB-level cascade (FK restrict) would abort
  // the delete instead of cascading — and the rows themselves belong to the
  // org, not to the user, so they are detached rather than deleted. Without
  // this, deleting a mentor who owns a project or an admin who is assigned a
  // support ticket failed with an opaque FK error.
  await prisma.supportTicket.updateMany({ where: { assignedAdminId: userId }, data: { assignedAdminId: null } });
  await prisma.mentorshipRequest.updateMany({ where: { decidedById: userId }, data: { decidedById: null } });
  await prisma.project.updateMany({ where: { ownerUserId: userId }, data: { ownerUserId: null } });
  await prisma.user.delete({ where: { id: userId } });
}

export async function anonymizeUser(userId: string): Promise<void> {
  await prisma.$transaction([
    // Remove uploaded file bytes; anonymize doesn't need the CV/photo to remain.
    prisma.cvFile.deleteMany({ where: { userId } }),
    prisma.avatarFile.deleteMany({ where: { userId } }),
    prisma.document.deleteMany({ where: { ownerId: userId } }),
    // Revoke consents — nothing left to process on their behalf.
    prisma.userConsent.updateMany({ where: { userId }, data: { revokedAt: new Date() } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        fullName: 'Erased candidate',
        email: `erased-${userId}@erased.local`,
        phone: null,
        whatsapp: null,
        city: null,
        birthDate: null,
        university: null,
        department: null,
        bio: null,
        displayName: null,
        avatarUrl: null,
        cvUrl: null,
        linkedinUrl: null,
        githubUrl: null,
        portfolioUrl: null,
        interests: null,
        targetPosition: null,
        skills: [],
        skillLevels: {},
        publicProfile: false,
        isActive: false,
      },
    }),
  ]);
}
