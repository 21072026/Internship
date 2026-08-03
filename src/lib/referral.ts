import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

// Personal referral links (#51).
//
// Two ways a person can bring someone in:
//   • an email invitation (InvitationToken) — one address, one role, and it can
//     wire up the mentorship on registration;
//   • a plain shareable link, /auth/register?ref=<code> — "send it to your
//     circle". Whoever signs up through it is recorded as referred by the owner
//     of the code, which is how a mentee (or a mentor, or an admin) shows up as
//     the *source* of a new account.
//
// The code is generated on first use so no existing row needs a backfill.

const CODE_BYTES = 5; // 8 base32-ish chars — short enough to paste in a message

function newCode() {
  return crypto.randomBytes(CODE_BYTES).toString('hex').toUpperCase();
}

/**
 * This user's referral code, creating one the first time it is asked for.
 * Returns null when there is no such user (the account was deleted between the
 * page render and this call — the caller turns that into a 404 rather than a
 * retry loop).
 */
export async function ensureReferralCode(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
  if (!user) return null;
  if (user.referralCode) return user.referralCode;

  // Only a code collision is worth retrying — and only P2002 says that. Any
  // other failure (missing row, connection) is rethrown as-is, so a real problem
  // is not disguised as "could not allocate a code".
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { referralCode: newCode() },
        select: { referralCode: true },
      });
      return updated.referralCode!;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return null;
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') throw e;
      // Someone else won the race on this row: take their code if it landed.
      const again = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
      if (again?.referralCode) return again.referralCode;
    }
  }
  throw new Error('Could not allocate a referral code');
}

/** The user behind a referral code, or null when it does not resolve. */
export async function resolveReferrer(code: string | null | undefined) {
  const trimmed = (code ?? '').trim().toUpperCase();
  if (!trimmed) return null;
  return prisma.user.findUnique({
    where: { referralCode: trimmed },
    select: { id: true, fullName: true, role: true, isActive: true },
  });
}

/** The absolute link to share. */
export function referralUrl(code: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return `${appUrl}/auth/register?ref=${code}`;
}
