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
 */

const TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret()).update(`google-oauth:${payload}`).digest('base64url');
}

export function makeState(userId: string, nonce: string, now = Date.now()): string {
  const payload = `${userId}.${nonce}.${now + TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state: string, now = Date.now()): { userId: string; nonce: string } | null {
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [userId, nonce, expiryRaw, sig] = parts;
  const payload = `${userId}.${nonce}.${expiryRaw}`;
  if (!safeEqual(sig, sign(payload))) return null;
  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry < now) return null;
  if (!userId || !nonce) return null;
  return { userId, nonce };
}
