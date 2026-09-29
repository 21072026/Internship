import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { World } from '@/lib/hostWorld';
import { findUsersByEmail, findUsersInWorld } from '@/lib/userWorld';

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

/**
 * Which account(s) an UNAUTHENTICATED "mail me a link" form acts on — the one
 * rule behind both /api/auth/forgot and /api/auth/verify-email/resend (#2590).
 *
 * WHY A RULE AT ALL. Before worlds an address was one account, so `where: { email }`
 * was the answer. Now one mailbox can hold an internship account AND a
 * marketing account, and these two forms have no session to say which. The one
 * signal is the HOST the form was served from (`world`, from
 * `worldForHeaders`): the URL decides which product you are in, so on
 * marketing.… "forgot password" means the marketing account.
 *
 * FALLBACK. If the address has no account in this world, the person may simply
 * be on the wrong door (they only ever registered on the other site). Then, and
 * only then, act on their account in the OTHER world — provided there is
 * EXACTLY ONE. Two or more (an address held by two organizations of another
 * product) is ambiguous and this helper refuses to guess: it returns nothing,
 * and the form's answer stays the generic one. The mail that follows links to
 * THAT account's own product (the mail builders derive the origin from the
 * account's `orgId`), so the fallback delivers the person to the right door
 * rather than to a page that cannot sign them in.
 *
 * Returns an array because more than one account in the SAME world is possible
 * (an admin moving an organization's product can make two organizations of one
 * vertical hold the address) and nobody may pick between them silently; the
 * caller mails a link for each, and each link acts on its own userId only.
 *
 * NO ENUMERATION. This decides who receives a mail; it says nothing to the
 * requester. Callers must keep answering the same body for "found", "found in
 * the other world", "ambiguous" and "no such address" — the fallback is invisible
 * on the wire.
 *
 * `select` is required (and stays the caller's explicit column list): these are
 * the routes a locked-out person reaches for, so they must not hydrate a Json
 * column (#1150, scripts/check-auth-reads.mjs).
 */
export async function findAccountsForMailedLink<S extends Prisma.UserSelect>(
  email: string,
  world: World,
  select: S,
): Promise<Prisma.UserGetPayload<{ select: S }>[]> {
  const inWorld = await findUsersInWorld(email, world, select);
  if (inWorld.length > 0) return inWorld;
  // Nothing in this world, so every account this address holds is in another
  // one — "any world" is deliberate here: this is the wrong-door rescue.
  const elsewhere = await findUsersByEmail(email, select);
  return elsewhere.length === 1 ? elsewhere : [];
}
