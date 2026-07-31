import { createHmac, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';

// Per-thread reply token used in email Reply-To addresses
// (reply+<relationId>.<sig>@domain). The signature is an HMAC of the relation
// id with the server secret, so tokens are unguessable and tamper-evident —
// an inbound email can only be routed to a thread if its token verifies.
// No fallback secret: a public default would make every token forgeable (#870).
function sign(relationId: string): string {
  return createHmac('sha256', requireServerSecret()).update(relationId).digest('hex').slice(0, 32);
}

export function makeReplyToken(relationId: string): string {
  return `${relationId}.${sign(relationId)}`;
}

export function verifyReplyToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const relationId = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(relationId);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return relationId;
}

export function replyAddress(relationId: string): string {
  const domain = process.env.INBOUND_EMAIL_DOMAIN || 'crm.ersah.in';
  return `reply+${makeReplyToken(relationId)}@${domain}`;
}

// Extract the reply token from a recipient address like
// "reply+<token>@domain" (handles display-name wrapped addresses too).
export function extractReplyToken(recipient: string): string | null {
  const m = recipient.match(/reply\+([^@>\s]+)@/i);
  return m ? m[1] : null;
}
