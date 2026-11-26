// The shape of a partner's referral code (#3550, docs/affiliate-module.md
// § Referral codes) — the ONE rule. Every place that accepts or recognises a
// code reads it from here: creating a partner and approving an application
// (src/lib/affiliatePartners.ts), the public page's `?ref=` redirect
// (src/lib/affiliateLandingRule.ts), the click link `/r/<code>`
// (src/lib/affiliateClickRule.ts) and the migration (src/lib/affiliateMigrationRule.ts).
//
// WHY `.` AND `@`. The previous affiliate system issued some codes from user
// names, so links in circulation carry `?ref=ada.lovelace` and
// `?ref=ada%40example` (`@` percent-encoded by the browser). A new code would
// break those links, so both characters are valid — a code still starts with a
// letter or a digit, and nothing else is allowed: no space, `/`, `?`, `#`, `%`
// or `&`, so a code is safe in a path segment and as a query value without
// further thought. Codes with a space are not carried over: the migration
// reports them as needing a new code.
//
// Dependency-free (no `@/` imports): unit-tested under plain node.

/** AffiliatePartner.code is VarChar(100): 1 leading + 99 more. */
export const PARTNER_CODE_MAX = 100;

export const PARTNER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/;

export function isPartnerCode(value: unknown): value is string {
  return typeof value === 'string' && PARTNER_CODE_RE.test(value);
}

/**
 * A code as it arrives in a URL path (`/r/ada%40example` or `/r/ada@example`):
 * percent-decoded once when it carries an escape. A valid code never contains
 * `%`, so decoding cannot turn one valid code into another; a malformed escape
 * is returned as it came (and then fails `isPartnerCode`).
 */
export function codeFromPath(raw: string): string {
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ── The partner's own code (#3961) ──────────────────────────────────────────
//
// A partner invited to open its account may replace the code it was given with
// one of its own choosing, on the registration form. Two limits keep a link in
// circulation working: the code is fixed once the account exists, and it is
// fixed as soon as it has been used at all — a click, a referred customer or a
// commission means the code is already printed somewhere (a migrated partner's
// `?ref=` links above all).

/** Letters and digits that cannot be misread: no 0/o, 1/l/i. */
export const RANDOM_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const RANDOM_CODE_LENGTH = 8;

/**
 * A random code of {@link RANDOM_CODE_LENGTH} characters from
 * {@link RANDOM_CODE_ALPHABET}. `random` returns integers in [0, n); the
 * default is the platform's CSPRNG, so the code is not guessable from the
 * previous one. Always a valid {@link isPartnerCode}.
 */
export function randomPartnerCode(random: (n: number) => number = cryptoInt): string {
  let out = '';
  for (let i = 0; i < RANDOM_CODE_LENGTH; i++) out += RANDOM_CODE_ALPHABET[random(RANDOM_CODE_ALPHABET.length)];
  return out;
}

function cryptoInt(n: number): number {
  // Rejection sampling: no modulo bias.
  const limit = 256 - (256 % n);
  const buf = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Why a partner's code can no longer be changed, or null when it can. */
export type CodeLock = 'has_account' | 'in_use' | null;

export function partnerCodeLock(p: { hasAccount: boolean; customers: number; clicks: number; commissions: number }): CodeLock {
  if (p.hasAccount) return 'has_account';
  if (p.customers > 0 || p.clicks > 0 || p.commissions > 0) return 'in_use';
  return null;
}

/**
 * Codes are unique per organisation as stored, but MySQL's default collation
 * compares them case-insensitively — `Ada` and `ada` collide. The availability
 * answer is therefore one of these, never the other partner's name.
 */
export type CodeAvailability = 'available' | 'current' | 'taken' | 'invalid';
