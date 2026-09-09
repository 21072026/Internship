/**
 * 2FA recovery codes — mint, count, consume, clear (#1542).
 *
 * WHY THIS EXISTS
 *   `require2fa` can be switched on for a whole organisation, and until now
 *   there was no way back into an account whose authenticator was lost: an
 *   admin had to edit MySQL by hand. That missing door is the reason a
 *   programme owner hesitated to turn the setting on at all. A recovery code is
 *   the standard answer — a one-shot second factor the person keeps on paper.
 *
 * WHAT MAKES THEM SAFE TO STORE
 *   Only a keyed hash is written. A recovery code carries ~38 bits (see
 *   recoveryCodeFormat.ts), which a bare SHA-256 digest would not protect: an
 *   attacker holding a database dump could enumerate the whole space offline in
 *   minutes. So the digest is an HMAC keyed by the server secret — the same
 *   pattern as the unsubscribe and e-mail-action tokens — and a dump without
 *   the environment is useless.
 *
 *   bcrypt (what a *password* gets) is deliberately not used here, and the
 *   reason is the verify side: a presented code has to be compared against up
 *   to ten stored hashes, and ten cost-12 bcrypt comparisons is several seconds
 *   of CPU on every attempt — a denial-of-service lever sitting on the sign-in
 *   path. A keyed hash over a CSPRNG secret needs no work factor; a work factor
 *   exists to protect *low-entropy human* input, which this is not.
 *
 * WHAT MAKES THEM SINGLE-USE
 *   `usedAt` is stamped by a conditional `updateMany` (`where: { id, usedAt:
 *   null }`), so two tabs submitting the same code at the same moment cannot
 *   both succeed: the loser updates zero rows and is refused like any wrong
 *   code. Checking `usedAt` in JavaScript and then writing would let both in.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/prisma';
import { requireServerSecret } from '@/lib/serverSecret';
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  codeFromBytes,
  formatRecoveryCode,
  normalizeRecoveryCode,
} from '@/lib/recoveryCodeFormat';

export { RECOVERY_CODE_COUNT, looksLikeRecoveryCode } from '@/lib/recoveryCodeFormat';

/**
 * HMAC-SHA-256 over the normalised code, namespaced so this secret's other
 * derivations can never collide with it.
 */
function hashRecoveryCode(normalized: string): string {
  return createHmac('sha256', requireServerSecret()).update(`2fa-recovery:${normalized}`).digest('hex');
}

export interface RecoveryCodeStatus {
  /** Codes in the current set. 0 when the user has never minted one. */
  total: number;
  /** How many of them are still spendable. */
  remaining: number;
  /** When the current set was minted, or null when there is none. */
  generatedAt: Date | null;
}

/** What the account page shows: a count, never a code. */
export async function recoveryCodeStatus(userId: string): Promise<RecoveryCodeStatus> {
  const rows = await prisma.twoFactorRecoveryCode.findMany({
    where: { userId },
    select: { usedAt: true, createdAt: true },
  });
  let remaining = 0;
  let generatedAt: Date | null = null;
  for (const r of rows) {
    if (!r.usedAt) remaining++;
    if (!generatedAt || r.createdAt > generatedAt) generatedAt = r.createdAt;
  }
  return { total: rows.length, remaining, generatedAt };
}

/**
 * Mint a fresh set and return the plaintext — the ONE moment it exists outside
 * the user's own notes. Nothing stores or logs it, and no later read can
 * reproduce it.
 *
 * The whole previous set goes, used rows included, in the same transaction: the
 * count on the account page has to mean "codes you can still use out of the set
 * you were given", and leaving spent rows from an older set behind would make
 * "3 of 13" of it. That a code was spent is recorded where it belongs, in the
 * activity log, not in a row that outlives the credential.
 */
export async function generateRecoveryCodes(userId: string): Promise<string[]> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
  if (!user) throw new Error('generateRecoveryCodes: unknown user');

  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < RECOVERY_CODE_COUNT) {
    const code = codeFromBytes(randomBytes(RECOVERY_CODE_LENGTH));
    // A duplicate inside one set would look like a working code that is already
    // spent. Astronomically unlikely; cheap to rule out.
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  await prisma.$transaction([
    prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    prisma.twoFactorRecoveryCode.createMany({
      data: codes.map((code) => ({
        userId,
        orgId: user.orgId,
        codeHash: hashRecoveryCode(code),
      })),
    }),
  ]);

  return codes.map(formatRecoveryCode);
}

/** Drop every code for a user — called when 2FA is switched off. */
export async function clearRecoveryCodes(userId: string): Promise<void> {
  await prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } });
}

/**
 * Spend a presented recovery code. True only when it matched an unused code of
 * this user's set AND this call is the one that stamped it.
 *
 * The comparison is timing-safe against every candidate, and the loop does not
 * break early: how long the answer takes must not narrow down which code — or
 * how many codes — the account holds.
 */
export async function consumeRecoveryCode(userId: string, presented: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(presented);
  if (normalized.length !== RECOVERY_CODE_LENGTH) return false;
  const presentedHash = Buffer.from(hashRecoveryCode(normalized), 'utf8');

  const rows = await prisma.twoFactorRecoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });

  let matchedId: string | null = null;
  for (const row of rows) {
    const stored = Buffer.from(row.codeHash, 'utf8');
    if (stored.length !== presentedHash.length) continue;
    if (timingSafeEqual(stored, presentedHash)) matchedId = row.id;
  }
  if (!matchedId) return false;

  // The race is decided here, in the database, not above in JavaScript.
  const { count } = await prisma.twoFactorRecoveryCode.updateMany({
    where: { id: matchedId, usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
}
