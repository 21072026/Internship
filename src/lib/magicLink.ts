// Magic-link sign-in (#1959) — the Prisma half. The rules live in
// src/lib/magicLinkToken.ts; this file is the only writer of LoginLinkToken.
//
// Three operations, mirroring the password-reset token it is modelled on
// (src/lib/passwordReset.ts) with one difference that matters: the table holds
// a HASH, so a row cannot be turned back into the link that was mailed.
import { prisma } from '@/lib/prisma';
import { LOGIN_LINK_TTL_MS, generateLoginLinkToken, hashLoginLinkToken } from '@/lib/magicLinkToken';

/**
 * Mint a sign-in link for a user and return the RAW token for the e-mail — the
 * one and only time it exists outside the mail. Every outstanding link of the
 * user is retired first, so only the newest mail works: a stale link in an
 * older message cannot be the one that is clicked.
 */
export async function createLoginLinkToken(userId: string, requestIp: string | null): Promise<string> {
  const now = new Date();
  await prisma.loginLinkToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: now },
  });
  const raw = generateLoginLinkToken();
  await prisma.loginLinkToken.create({
    data: {
      tokenHash: hashLoginLinkToken(raw),
      userId,
      requestIp,
      expiresAt: new Date(now.getTime() + LOGIN_LINK_TTL_MS),
    },
  });
  return raw;
}

/** The row behind a presented link, or null. A read, not an admission. */
export async function findLoginLink(raw: string) {
  return prisma.loginLinkToken.findUnique({
    where: { tokenHash: hashLoginLinkToken(raw) },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });
}

/**
 * Admit exactly one sign-in on a link. The check (unspent, unexpired) and the
 * stamp are ONE conditional UPDATE, so of any number of concurrent redemptions
 * — two tabs, a double-fired effect, a leaked URL raced against its owner —
 * exactly one sees `true`. Same rule as the SSO grant (src/lib/grantSpend.ts)
 * and the 2FA recovery codes.
 */
export async function spendLoginLink(id: string, now: Date = new Date()): Promise<boolean> {
  const result = await prisma.loginLinkToken.updateMany({
    where: { id, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  return result.count === 1;
}

/**
 * Nightly housekeeping, run from the trusted-device purge. A spent or expired
 * row can admit nothing, and there is no replay to recognise (the hash of a
 * spent link is refused by `spendLoginLink` whether or not the row exists), so
 * nothing is kept: every row past its expiry goes.
 */
export async function purgeExpiredLoginLinks(now: Date = new Date()): Promise<number> {
  const r = await prisma.loginLinkToken.deleteMany({ where: { expiresAt: { lt: now } } });
  return r.count;
}
