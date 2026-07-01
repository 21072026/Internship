import { createHmac, timingSafeEqual } from 'crypto';

// Signed token embedded in retention re-consent emails: renew+<userId>.<sig>.
// The signature is an HMAC of the user id with the server secret, so the link
// is unguessable and tamper-evident and needs no extra DB table (mirrors
// lib/replyToken). Renewing is a deliberate POST from the landing page, so the
// GET link itself never mutates state.
const secret = () => process.env.NEXTAUTH_SECRET || 'dev-secret';

function sign(userId: string): string {
  return createHmac('sha256', secret()).update(`consent-renew:${userId}`).digest('hex').slice(0, 32);
}

export function makeConsentRenewToken(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

export function verifyConsentRenewToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(userId);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return userId;
}
