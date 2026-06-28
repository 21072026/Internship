import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';

const TTL_MS = 2 * 60 * 1000; // 2 minutes — consumed immediately by the sign-in

// Mint a single-use grant that authorizes an impersonation sign-in.
export async function createImpersonationGrant(adminId: string, targetId: string, kind: 'START' | 'STOP') {
  const token = randomBytes(32).toString('hex');
  await prisma.impersonationGrant.create({
    data: { token, adminId, targetId, kind, expiresAt: new Date(Date.now() + TTL_MS) },
  });
  return token;
}
