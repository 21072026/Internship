import { createHash } from 'crypto';
import { logger } from '@/lib/logger';
import { sanitizeError } from '@/lib/sanitizeError';
import { assertPublicHttpsUrl } from '@/lib/ssrfGuard';
import { matchHibpRange, splitSha1 } from '@/lib/passwordPolicyRule';

// Breached-password screening against Have I Been Pwned (#1544), k-anonymity
// range API. The privacy contract, in one sentence: ONLY THE FIRST FIVE HEX
// CHARACTERS of the password's SHA-1 ever leave this process; the API answers
// with every suffix in that range and the match happens here. The password and
// its full hash never go on the wire and are never logged.
//
// FAIL OPEN. An unreachable, slow or broken HIBP must never block a sign-up, a
// reset or a password change — a third-party outage is not a reason to lock a
// person out of their own account. A failed lookup answers `checked: false`,
// logs one warning, and the caller treats the password as not known to be
// breached. The switch `breachedPasswordCheck` (settings) turns the lookup off.
//
// The URL goes through the SSRF guard like every other server-side fetch. The
// e2e run points HIBP_RANGE_URL at a local stub over plain http and sets
// HIBP_ALLOW_INSECURE_STUB=1 to skip the guard for it — a test-only switch that
// logs when it takes effect and is never set on a deployment.

export const HIBP_RANGE_URL_DEFAULT = 'https://api.pwnedpasswords.com/range';
/** A receiver that cannot answer a range query in two seconds is treated as down. */
export const HIBP_TIMEOUT_MS = 2000;

export function hibpRangeBase(): string {
  return (process.env.HIBP_RANGE_URL || HIBP_RANGE_URL_DEFAULT).replace(/\/+$/, '');
}

export function insecureHibpStubAllowed(): boolean {
  return process.env.HIBP_ALLOW_INSECURE_STUB === '1';
}

export type BreachLookup =
  | { checked: true; breached: boolean; count: number }
  | { checked: false; reason: string };

export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Ask HIBP whether `password` is in the corpus. Never throws: a failure is a
 * `checked: false` result (see the header on failing open).
 */
export async function lookupBreachedPassword(
  password: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<BreachLookup> {
  const timeoutMs = opts.timeoutMs ?? HIBP_TIMEOUT_MS;
  // SHA-1 on purpose, and NOT as a password hash: it is the key the HIBP range
  // API is indexed by (the protocol dictates it), it is never stored, never
  // compared against a stored value and never sent whole — only its first five
  // hex characters leave the process (splitSha1). Storage hashing stays bcrypt
  // (cost 12) in the routes that call this. CodeQL reads "a password into a
  // fast hash" and cannot see the k-anonymity contract, hence the suppression.
  // codeql[js/insufficient-password-hash]
  const sha = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const { prefix, suffix } = splitSha1(sha);
  const url = `${hibpRangeBase()}/${prefix}`;
  try {
    if (insecureHibpStubAllowed()) {
      logger.warning('breached-password check: insecure HIBP stub allowed by HIBP_ALLOW_INSECURE_STUB (test switch)');
    } else {
      await assertPublicHttpsUrl(url);
    }
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'GET',
      // Padding makes every response the same shape, so the response size does
      // not say how common the range is.
      headers: { 'Add-Padding': 'true', 'User-Agent': 'InternCRM-password-policy' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const count = matchHibpRange(await res.text(), suffix);
    return { checked: true, breached: count > 0, count };
  } catch (e) {
    const raw = e instanceof Error ? (e.name === 'TimeoutError' ? `timeout after ${timeoutMs} ms` : e.message) : String(e);
    const reason = sanitizeError(raw) ?? 'lookup failed';
    // One line, no password, no hash, no prefix: the warning is for the
    // operator who wonders why the screening is quiet, not a record of attempts.
    logger.warning('breached-password check unavailable; failing open', { reason });
    return { checked: false, reason };
  }
}
