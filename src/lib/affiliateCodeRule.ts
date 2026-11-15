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
