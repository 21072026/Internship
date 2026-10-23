// The partner's referral link (docs/affiliate-module.md, #3117) — pure and
// dependency-free (scripts/test/affiliate-referral-rule.test.mjs).
//
// The address a partner shares is organisation data: the programme settings hold
// a base URL (the product's own site, say), and the link is that URL with
// `ref=<code>` set. Without a base URL the portal shows the code alone.
//
// A base URL is https only, carries no credentials and no fragment, is at most
// REFERRAL_URL_MAX_CHARS long, and does not set `ref` itself (the partner's code
// must be the only one). It is stored as the URL parser prints it.

export const REFERRAL_URL_MAX_CHARS = 500;

export type ReferralUrlIssue = 'invalid' | 'not_https' | 'credentials' | 'fragment' | 'has_ref' | 'too_long';

export function parseReferralUrl(raw: unknown): { ok: true; url: string | null } | { ok: false; issue: ReferralUrlIssue } {
  if (raw === null || raw === undefined) return { ok: true, url: null };
  if (typeof raw !== 'string') return { ok: false, issue: 'invalid' };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, url: null };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, issue: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, issue: 'not_https' };
  if (url.username || url.password) return { ok: false, issue: 'credentials' };
  if (url.hash) return { ok: false, issue: 'fragment' };
  if (url.searchParams.has('ref')) return { ok: false, issue: 'has_ref' };
  const printed = url.toString();
  if (printed.length > REFERRAL_URL_MAX_CHARS) return { ok: false, issue: 'too_long' };
  return { ok: true, url: printed };
}

/** The link a partner shares; null without a (valid) base URL. */
export function referralLink(base: string | null | undefined, code: string): string | null {
  const parsed = parseReferralUrl(base);
  if (!parsed.ok || !parsed.url) return null;
  const url = new URL(parsed.url);
  url.searchParams.set('ref', code);
  return url.toString();
}
