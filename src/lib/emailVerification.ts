import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Issue a single-use email-verification token for a user, invalidating any
 * previous unused ones. Returns the raw token for the email link.
 */
export async function createEmailVerificationToken(userId: string) {
  await prisma.emailVerificationToken.updateMany({
    where: { userId, used: false },
    data: { used: true },
  });
  const token = randomBytes(32).toString('hex');
  await prisma.emailVerificationToken.create({
    data: { token, userId, expiresAt: new Date(Date.now() + TTL_MS) },
  });
  return token;
}
