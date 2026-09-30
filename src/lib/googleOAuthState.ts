import { createHmac } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';
import { safeEqual } from '@/lib/secretBox';

/**
 * The OAuth `state` for the Google connect flow (#709).
 *
 * Signed and self-describing rather than a row in a table: it has to survive a
 * round trip through Google and come back proving three things — that this
 * browser started the flow, WHICH user started it, and that it started recently.
 * An HMAC over `userId:nonce:expiry` proves all three with no storage to clean
 * up, mirroring lib/replyToken and lib/consentRenew.
 *
 * Binding the user id into the state is the part that matters: without it a
 * callback could be replayed into a different signed-in session and attach one
 * person's Google account to another person's profile.
 *
 * The ORIGIN the flow started on (#2494) is signed in as well. Google sends the
 * browser back to the one redirect_uri registered with it (NEXTAUTH_URL's host),
 * where a user who connected from the marketing host has no session — cookies
 * are host-only. The callback reads the origin out of a state that verifies and
 * forwards the browser, code and state untouched, to the same callback on that
 * host, which then does everything it always did (session check included). The
 * origin is signed so that nobody can mint a state that forwards somewhere
 * else, and it is re-checked against servedHosts() on the way out anyway: the
 * signature proves WE wrote it, the allowlist proves this deployment still
 * serves it. It is stored base64url-encoded because an origin contains dots,
 * the field separator.
 *
 * Format: `userId.nonce.expiry.origin64.sig` (5 parts). The old 4-part form
 * (no origin) still verifies, with `origin: null`, so a flow started on the
 * previous build during a deploy is not refused — its TTL is ten minutes.
 */

const TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret()).update(`google-oauth:${payload}`).digest('base64url');
}

export function makeState(userId: string, nonce: string, now = Date.now(), origin: string | null = null): string {
  const base = `${userId}.${nonce}.${now + TTL_MS}`;
  const payload = origin ? `${base}.${Buffer.from(origin, 'utf8').toString('base64url')}` : base;
  return `${payload}.${sign(payload)}`;
}

export function verifyState(
  state: string,
  now = Date.now()
): { userId: string; nonce: string; origin: string | null } | null {
  const parts = state.split('.');
  if (parts.length !== 4 && parts.length !== 5) return null;
  const sig = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join('.');
  if (!safeEqual(sig, sign(payload))) return null;
  const [userId, nonce, expiryRaw, origin64] = parts;
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry < now) return null;
  if (!userId || !nonce) return null;
  let origin: string | null = null;
  if (parts.length === 5) {
    if (!origin64) return null;
    origin = Buffer.from(origin64, 'base64url').toString('utf8') || null;
  }
  return { userId, nonce, origin };
}
