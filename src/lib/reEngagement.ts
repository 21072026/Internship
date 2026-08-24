import { createHmac } from 'crypto';
import { prisma } from '@/lib/prisma';
import { requireServerSecret } from '@/lib/serverSecret';
import { safeEqual } from '@/lib/secretBox';

/**
 * The re-engagement pool (#834).
 *
 * A candidate who did not place this cycle currently sits in the pipeline
 * forever: never closed, never advanced. That is bad twice over — the funnel
 * report fills with people who will never move, and the person is quietly
 * forgotten. "Not this time; we will write in September when places open" is
 * both the honest answer and the cheapest recruiting there is.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DISTINCTION THIS FILE EXISTS TO PROTECT
 *
 * There are two different permissions here and they must never merge:
 *
 *   1. "Write to me again"      → ConsentType.RE_ENGAGEMENT_POOL, this file.
 *   2. "Keep storing my data"   → User.consentAt, governed by lib/retention.
 *
 * Joining the pool does NOT touch consentAt and so does NOT move the retention
 * clock. If it did, a feature whose stated purpose is partly to END indefinite
 * retention would itself produce indefinite retention. Every write below is
 * deliberately narrow for that reason, and a test asserts consentAt is
 * unchanged after pooling.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Default distance for "let's talk again" when the caller names no date. */
export const DEFAULT_RE_ENGAGE_MONTHS = 6;

export function defaultReEngageDate(from: Date = new Date()): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() + DEFAULT_RE_ENGAGE_MONTHS);
  return d;
}

/**
 * A signed one-click "take me out" token.
 *
 * Leaving has to work straight from the e-mail, months later, without a login —
 * asking someone to remember a password before they can stop being contacted is
 * how you end up contacting people who wanted out. Same HMAC pattern as
 * lib/consentRenew and lib/replyToken: unguessable, tamper-evident, no table.
 */
function sign(userId: string): string {
  return createHmac('sha256', requireServerSecret()).update(`re-engage-leave:${userId}`).digest('hex').slice(0, 32);
}

export function makeLeaveToken(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

export function verifyLeaveToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(userId))) return null;
  return userId;
}

/** Does this person currently permit being contacted again? */
export async function hasPoolConsent(userId: string): Promise<boolean> {
  const row = await prisma.userConsent.findFirst({
    where: { userId, type: 'RE_ENGAGEMENT_POOL', grantedAt: { not: null }, revokedAt: null },
    select: { id: true },
  });
  return !!row;
}

/**
 * Put someone in the pool — only ever with their own consent.
 *
 * The consent is checked here rather than trusted from the caller, because
 * "admin decided to keep them on standby" is exactly the thing this must not
 * become. Returns false when consent is absent, and the caller shows the
 * invitation instead.
 */
export async function joinPool(
  userId: string,
  opts: { at?: Date; note?: string | null } = {}
): Promise<boolean> {
  if (!(await hasPoolConsent(userId))) return false;
  await prisma.user.update({
    where: { id: userId },
    data: {
      reEngageAt: opts.at ?? defaultReEngageDate(),
      reEngageNote: opts.note ?? null,
      // A new date is a new promise, so the "already told them" stamp clears.
      reEngageNotifiedAt: null,
      // NOTE the absence of consentAt here. See the header.
    },
  });
  return true;
}

/**
 * Take someone out of the pool.
 *
 * `alsoRevokeConsent` is what the one-click e-mail link uses: someone pressing
 * "stop writing to me" means the permission, not just this one date. An admin
 * clearing a date does not revoke anything.
 */
export async function leavePool(userId: string, opts: { alsoRevokeConsent?: boolean } = {}): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { reEngageAt: null, reEngageNote: null, reEngageNotifiedAt: null },
  });
  if (opts.alsoRevokeConsent) {
    await prisma.userConsent.updateMany({
      where: { userId, type: 'RE_ENGAGEMENT_POOL', revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  // Leaving returns the person to the ordinary retention policy — which was
  // never suspended, because joining never touched it.
}

/** Everyone whose "let's talk again" date has arrived and who has not been told. */
export async function dueForReminder(now: Date = new Date()) {
  return prisma.user.findMany({
    where: {
      reEngageAt: { not: null, lte: now },
      reEngageNotifiedAt: null,
      // Consent can be revoked after the date was set; the cron must re-check
      // rather than trust the date it finds.
      consents: { some: { type: 'RE_ENGAGEMENT_POOL', grantedAt: { not: null }, revokedAt: null } },
    },
    select: { id: true, email: true, fullName: true, reEngageAt: true, reEngageNote: true },
  });
}
