// Magic-link sign-in tokens (#1959) — the dependency-free half.
//
// A sign-in link is a bearer credential that lives in an e-mail for fifteen
// minutes, so the rules about it are kept where a unit test can hold them:
// what a token looks like, how it is stored (never raw), and when a stored row
// may still admit a sign-in. The Prisma half (minting, spending, purging) is
// src/lib/magicLink.ts; the NextAuth `magic` provider in src/lib/auth.ts
// consumes it.
//
// Run the tests: node --test --experimental-strip-types scripts/test/magic-link-token.test.mjs
import { createHash, randomBytes } from 'crypto';

/** How long a sign-in link admits a sign-in. Short on purpose: the link is a
 * credential sitting in a mailbox, and fifteen minutes covers "open the mail
 * on the phone you are holding" without covering "found in the inbox next
 * week". */
export const LOGIN_LINK_TTL_MS = 15 * 60 * 1000;

/** 32 random bytes, hex — 256 bits, so the hash below is never the weak link. */
export function generateLoginLinkToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * What is stored for a token: its SHA-256, hex. The raw value is in exactly one
 * place — the e-mail — and a row read out of the table (a backup, a support
 * query, a log line) is not a sign-in. Same shape as API keys (src/lib/apiKey.ts)
 * and trusted devices (src/lib/trustedDevice.ts).
 */
export function hashLoginLinkToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** The columns the liveness rule reads; the Prisma row satisfies it. */
export interface LoginLinkState {
  expiresAt: Date;
  usedAt: Date | null;
}

/**
 * May this row still admit a sign-in? Unspent and unexpired, nothing else.
 * The provider asks this before doing any work for the link — but the admission
 * itself is the conditional UPDATE in `spendLoginLink()`, never this read.
 */
export function isLoginLinkLive(row: LoginLinkState, now: Date = new Date()): boolean {
  return row.usedAt === null && row.expiresAt.getTime() > now.getTime();
}
