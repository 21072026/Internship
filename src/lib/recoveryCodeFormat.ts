/**
 * The shape of a 2FA recovery code (#1542) — minting, normalising, recognising.
 *
 * Split out from `recoveryCodes.ts` (which needs Prisma and the server secret)
 * so the *format* rules are dependency-free and unit-testable under plain
 * `node --test`. They are worth pinning: three separate decisions live here and
 * each of them is a security or usability property, not a preference.
 *
 * 1. THE ALPHABET has no `0/o`, `1/l/i`, `5/s` or `2/z`. A person reads these
 *    codes off a screen once, writes them on paper, and types them back months
 *    later on the worst possible day — the day their phone is gone. A pair that
 *    can be misread is a code that silently does not work, and the sign-in form
 *    cannot tell them why. 27 symbols × 8 characters is ~38 bits, and the
 *    recovery path is rate-limited in its own bucket on top of that.
 *
 * 2. NORMALISATION is aggressive and one-way: lowercase, and every character
 *    outside the alphabet dropped — so the dash is cosmetic, and a code pasted
 *    with spaces, a trailing newline or in capitals still matches. The hash is
 *    taken over the normalised form, so this function is part of the
 *    credential: changing it invalidates every stored code.
 *
 * 3. RECOGNITION (`looksLikeRecoveryCode`) is what keeps the two second-factor
 *    kinds apart in one input field. A 6-digit TOTP code normalises to fewer
 *    than 8 alphabet characters (and `0`/`1` are not in the alphabet at all),
 *    so it can never be mistaken for a recovery code and spend an attempt from
 *    the recovery bucket.
 */

/** How many codes a set holds. Ten is the industry-standard size. */
export const RECOVERY_CODE_COUNT = 10;

/** Characters per code, excluding the cosmetic dash. */
export const RECOVERY_CODE_LENGTH = 8;

/** Where the dash goes when the code is displayed (`xxxx-xxxx`). */
const GROUP = 4;

/**
 * Unambiguous lowercase alphabet — see note 1 above. Exported so the unit test
 * can assert the confusable characters stay out of it.
 */
export const RECOVERY_CODE_ALPHABET = 'abcdefghjkmnpqrtuvwxy346789';

/** Strip the presentation: lowercase, and keep only alphabet characters. */
export function normalizeRecoveryCode(input: string): string {
  const lower = (input || '').toLowerCase();
  let out = '';
  for (const ch of lower) if (RECOVERY_CODE_ALPHABET.includes(ch)) out += ch;
  return out;
}

/** `abcdefgh` → `abcd-efgh`. Display only; never hashed in this form. */
export function formatRecoveryCode(normalized: string): string {
  if (normalized.length <= GROUP) return normalized;
  return `${normalized.slice(0, GROUP)}-${normalized.slice(GROUP)}`;
}

/**
 * Could this submitted second factor be a recovery code?
 *
 * Deliberately a pure shape test, not a database lookup: it decides which of
 * the two failure buckets an attempt is charged to, and that decision must not
 * depend on whether the account happens to hold matching codes.
 */
export function looksLikeRecoveryCode(input: string): boolean {
  return normalizeRecoveryCode(input).length === RECOVERY_CODE_LENGTH;
}

/**
 * Mint one code from caller-supplied random bytes.
 *
 * The randomness is passed in rather than read here so this module stays
 * dependency-free (and so the test can feed it known bytes). `bytes` must hold
 * at least RECOVERY_CODE_LENGTH values.
 *
 * The modulo bias is real but negligible: 256 % 27 leaves the first 13 symbols
 * a 10/256 chance against 9/256 for the rest — worth about 0.03 bits over the
 * whole code, against ~38. Rejection sampling here would buy nothing and add
 * a loop that can, in principle, not terminate.
 */
export function codeFromBytes(bytes: ArrayLike<number>): string {
  if (bytes.length < RECOVERY_CODE_LENGTH) {
    throw new Error(`codeFromBytes needs at least ${RECOVERY_CODE_LENGTH} bytes`);
  }
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    out += RECOVERY_CODE_ALPHABET[bytes[i] % RECOVERY_CODE_ALPHABET.length];
  }
  return out;
}
