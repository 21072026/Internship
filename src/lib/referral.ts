import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { originForWorld } from '@/lib/hostWorld';
import { worldOfOrg, worldUserWhere } from '@/lib/userWorld';
import { DEFAULT_VERTICAL, type VerticalKey } from '@/lib/verticals';

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

/**
 * The user behind a referral code, or null when it does not resolve.
 *
 * `world` (#2590), optional and trailing: when the caller is registering
 * someone INTO a world, only a referrer of that same world counts. A referral
 * code is globally unique, so without this a code minted by a marketing user and
 * pasted into an internship sign-up would stamp `referredById` with a person
 * from the other tenant — a cross-product link between two accounts that are
 * supposed to be strangers, and one that would surface the referrer's name to
 * the wrong product's admins. Refusing is silent (no referral credit), which is
 * the safe direction: a code that resolves in no world is just an unknown code.
 * Omitted, the lookup is exactly what it always was.
 */
export async function resolveReferrer(code: string | null | undefined, world?: VerticalKey) {
  const trimmed = (code ?? '').trim().toUpperCase();
  if (!trimmed) return null;
  const select = { id: true, fullName: true, role: true, isActive: true } as const;
  if (world) {
    // findFirst, not findUnique: the world filter is a relation condition, and
    // the code stays unique so this still matches at most one row.
    return prisma.user.findFirst({ where: { referralCode: trimmed, ...worldUserWhere(world) }, select });
  }
  return prisma.user.findUnique({ where: { referralCode: trimmed }, select });
}

/**
 * The absolute link to share.
 *
 * `origin` (#2590), optional and trailing: the host the link opens on. A
 * referral link is built FOR a user, and what it is for is bringing someone into
 * that user's own product — so a marketing user's link must open the marketing
 * host's sign-up, not the internship one. Callers that know the user resolve it
 * with `referralUrlForOrg`; without an origin this is the internship link it
 * always was.
 */
export function referralUrl(code: string, origin?: string): string {
  const base = origin ?? (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000');
  return `${base}/auth/register?ref=${code}`;
}

/**
 * The link to share for a user who belongs to this organization: their WORLD's
 * origin (#2590). INTERNSHIP — and a user with no org — get the exact string
 * `referralUrl(code)` has always returned (not `originForWorld()`'s normalised
 * form), so a single-world deployment's links do not change by a byte.
 */
export async function referralUrlForOrg(code: string, orgId: string | null | undefined): Promise<string> {
  const world = await worldOfOrg(orgId);
  return referralUrl(code, world === DEFAULT_VERTICAL ? undefined : originForWorld(world));
}
