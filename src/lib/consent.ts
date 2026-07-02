import { prisma } from '@/lib/prisma';
import type { ConsentType } from '@prisma/client';

// Reusable consent helpers (EPIC B2). A consent is active when it has been
// granted and not since revoked. Gates optional processing (e.g. AI CV parsing).

export async function hasConsent(userId: string, type: ConsentType): Promise<boolean> {
  const c = await prisma.userConsent.findUnique({
    where: { userId_type: { userId, type } },
    select: { grantedAt: true, revokedAt: true },
  });
  return !!c?.grantedAt && !c.revokedAt;
}

export async function setConsent(userId: string, type: ConsentType, granted: boolean) {
  const now = new Date();
  return prisma.userConsent.upsert({
    where: { userId_type: { userId, type } },
    create: {
      userId,
      type,
      grantedAt: granted ? now : null,
      revokedAt: granted ? null : now,
    },
    update: granted ? { grantedAt: now, revokedAt: null } : { revokedAt: now },
  });
}

export async function getConsents(userId: string): Promise<Record<string, boolean>> {
  const rows = await prisma.userConsent.findMany({
    where: { userId },
    select: { type: true, grantedAt: true, revokedAt: true },
  });
  const out: Record<string, boolean> = {};
  for (const r of rows) out[r.type] = !!r.grantedAt && !r.revokedAt;
  return out;
}
