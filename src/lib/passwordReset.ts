import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { World } from '@/lib/hostWorld';
import { findUsersInWorld } from '@/lib/userWorld';

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
 * One mailbox can hold an internship account AND a marketing account, and these
 * forms have no session to say which. The one signal is the HOST the form was
 * served from (`world`, from `worldForHeaders`): the URL decides which product
 * you are in, so on the marketing host "forgot password" means the marketing
 * account — and ONLY that one.
 *
 * NO CROSS-WORLD RESCUE. This used to fall back to the address's account in the
 * OTHER world when this one had none, and mail that account a link into its own
 * product: "forgot password" on SaleVali produced an Internship CRM mail with an
 * interncrm.com link. The product rule is that an action stays in the world it
 * was started in — brand, links and the account it touches — so an address with
 * no account in this world gets no mail at all.
 *
 * Returns an array because more than one account in the SAME world is possible
 * (an admin moving an organization's product can make two organizations of one
 * vertical hold the address) and nobody may pick between them silently; the
 * caller mails a link for each, and each link acts on its own userId only.
 *
 * NO ENUMERATION. This decides who receives a mail; it says nothing to the
 * requester. Callers must keep answering the same body for "found" and
 * "no such address in this world".
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
  return findUsersInWorld(email, world, select);
}
