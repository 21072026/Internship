// Durable brute-force lockout (#1541).
//
// Until now the failure counter behind sign-in lived only in the in-process Map
// of `rateLimit()`. That has three consequences the product could not live with:
// it evaporates on every redeploy (a redeploy is a free reset for an attacker),
// an admin cannot see that an account is locked, and an admin cannot clear a
// lockout for a user who locked themselves out.
//
// This module keeps the same *policy* (10 password failures / 15 minutes,
// 5 TOTP failures / 15 minutes — see auth.ts) but stores the counter in MySQL,
// in the `AccountLockout` table. Deliberately no Redis and no new
// infrastructure: on a single-host Plesk deployment the database we already run
// is the durable store, and distributed rate limiting is downstream of the
// multi-replica work.
//
// The read happens BEFORE the bcrypt compare on purpose: a cost-12 hash is the
// expensive part of a brute-force attempt, an indexed point lookup is not.

import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

export type LockoutReason = 'password' | 'totp';

// How long a tripped bucket stays locked. Same length as the counting window,
// so the durable behaviour matches what the in-memory limiter always did.
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export interface ActiveLockout {
  email: string;
  userId: string | null;
  reason: string;
  failedCount: number;
  lockedUntil: Date;
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function toActive(row: {
  email: string;
  userId: string | null;
  reason: string;
  failedCount: number;
  lockedUntil: Date | null;
}): ActiveLockout | null {
  if (!row.lockedUntil || row.lockedUntil.getTime() <= Date.now()) return null;
  return {
    email: row.email,
    userId: row.userId,
    reason: row.reason,
    failedCount: row.failedCount,
    lockedUntil: row.lockedUntil,
  };
}

/**
 * The live lockout for one stage of one address, or null when that stage is not
 * locked.
 *
 * The stage is required, and that is the whole point: the password gate must
 * ask about the password counter only. Asking a single shared counter meant
 * five fumbled authenticator codes locked the password stage too — and once the
 * password check is refused it can no longer raise `2FA_REQUIRED`, so the
 * sign-in form never reveals the code field again and a legitimate user with
 * 2FA on is shut out of their own account for the rest of the window.
 *
 * Never throws: a database hiccup must not turn into "nobody can sign in". That
 * is the same trade the in-memory limiter always made — the lockout is a brake
 * on guessing, not the authentication decision itself.
 */
export async function getActiveLockout(
  email: string,
  reason: LockoutReason,
): Promise<ActiveLockout | null> {
  try {
    const row = await prisma.accountLockout.findUnique({
      where: { email_reason: { email: normalize(email), reason } },
    });
    return row ? toActive(row) : null;
  } catch (e) {
    logger.error('Lockout lookup failed', { error: String(e) });
    return null;
  }
}

/**
 * Record one failed attempt and lock the address once it has burned through
 * `limit` failures inside the window.
 *
 * Returns the lockout when the address is locked after this attempt, else null.
 * Never throws.
 *
 * One row per address PER STAGE, exactly mirroring the two separate in-memory
 * buckets in auth.ts: the password counter is judged against 10 failures, the
 * TOTP counter against 5, and neither can consume the other's allowance. That
 * separation is not tidiness — sharing one row let a fumbled authenticator code
 * lock the password stage, which is the one thing that must keep working for
 * the form to be able to ask for a code at all.
 */
export async function recordFailedAttempt(opts: {
  email: string;
  userId?: string | null;
  orgId?: string | null;
  reason: LockoutReason;
  limit: number;
  windowMs?: number;
  ip?: string | null;
}): Promise<ActiveLockout | null> {
  const email = normalize(opts.email);
  const windowMs = opts.windowMs ?? LOCKOUT_WINDOW_MS;
  const now = new Date();
  try {
    const key = { email, reason: opts.reason };
    const existing = await prisma.accountLockout.findUnique({ where: { email_reason: key } });
    const stillLocked = !!existing?.lockedUntil && existing.lockedUntil.getTime() > now.getTime();
    // A counting window that has run out starts a fresh count — otherwise one
    // fumbled password a week would eventually lock an account nobody attacked.
    const freshWindow =
      !stillLocked && (!existing || existing.windowStart.getTime() + windowMs <= now.getTime());
    const failedCount = freshWindow ? 1 : (existing?.failedCount ?? 0) + 1;
    const lockedUntil =
      failedCount >= opts.limit
        ? new Date(now.getTime() + windowMs)
        : (existing?.lockedUntil ?? null);

    const data = {
      userId: opts.userId ?? null,
      orgId: opts.orgId ?? null,
      reason: opts.reason,
      failedCount,
      windowStart: freshWindow ? now : (existing?.windowStart ?? now),
      lockedUntil,
      lastIp: opts.ip ?? null,
    };
    const row = await prisma.accountLockout.upsert({
      where: { email_reason: key },
      create: { email, ...data },
      update: data,
    });
    return toActive(row);
  } catch (e) {
    logger.error('Lockout write failed', { error: String(e) });
    return null;
  }
}

/**
 * Drop the counters after a fully successful sign-in — both stages, since the
 * whole credential check is through. Never throws.
 */
export async function clearLockoutByEmail(email: string): Promise<void> {
  try {
    await prisma.accountLockout.deleteMany({ where: { email: normalize(email) } });
  } catch (e) {
    logger.error('Lockout clear failed', { error: String(e) });
  }
}

/**
 * Admin unlock: drop every counter belonging to an account.
 *
 * Matched by userId *and* by the account's current address, because a row
 * written before the address was recognised carries the typed email and no id.
 */
export async function clearLockoutForUser(userId: string, email: string): Promise<number> {
  const { count } = await prisma.accountLockout.deleteMany({
    where: { OR: [{ userId }, { email: normalize(email) }] },
  });
  return count;
}

/** Currently-locked accounts, for the admin user list. Expired rows are ignored. */
export interface LockoutView {
  userId: string | null;
  email: string;
  reason: string;
  failedCount: number;
  lockedUntil: string;
}

export async function listActiveLockouts(): Promise<LockoutView[]> {
  const rows = await prisma.accountLockout.findMany({
    where: { lockedUntil: { gt: new Date() } },
    select: { userId: true, email: true, reason: true, failedCount: true, lockedUntil: true },
    take: 500,
  });
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    reason: r.reason,
    failedCount: r.failedCount,
    lockedUntil: (r.lockedUntil as Date).toISOString(),
  }));
}
