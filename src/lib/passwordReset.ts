import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';

export type ResetPurpose = 'RESET' | 'SET_INITIAL';

// TTL per purpose: short-lived for self-service resets, longer for the
// "set your initial password" link a new mentee receives by email.
const TTL_MS: Record<ResetPurpose, number> = {
  RESET: 60 * 60 * 1000, // 1 hour
  SET_INITIAL: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * Issue a single-use password token for a user. Any previous unused tokens for
 * the same user are invalidated so only the newest link works. Returns the raw
 * token to embed in the email link.
 */
export async function createPasswordResetToken(userId: string, purpose: ResetPurpose = 'RESET') {
  await prisma.passwordResetToken.updateMany({
    where: { userId, used: false },
    data: { used: true },
  });

  const token = randomBytes(32).toString('hex');
  await prisma.passwordResetToken.create({
    data: {
      token,
      userId,
      purpose,
      expiresAt: new Date(Date.now() + TTL_MS[purpose]),
    },
  });
  return token;
}
