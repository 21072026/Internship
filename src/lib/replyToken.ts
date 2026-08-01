import { createHmac, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';

// Per-thread reply token used in email Reply-To addresses
// (reply+<payload>.<sig>@domain). The signature is an HMAC of the payload with
// the server secret, so tokens are unguessable and tamper-evident — an inbound
// email can only be routed to a thread if its token verifies.
// No fallback secret: a public default would make every token forgeable (#870).
//
// The payload is `<relationId>~<recipientUserId>`: it names both the thread and
// the person the notification went to. That second half is what makes a reply
// work when someone answers from a different address than the one on their
// account — a notification forwarded to Gmail gets replied to with the Gmail
// identity, and matching `From` against the account email rejected exactly those
// replies. Since the notification is only ever delivered to that user's
// registered address, anyone holding it could already take the account over via a
// password reset, so honouring the token grants no access they didn't have.
//
// Tokens minted before this carry a bare relationId and still verify; they name
// no recipient, so those replies fall back to matching `From`. See
// `routeInboundEmail` in src/lib/inboundEmail.ts.
//
// `~` separates the two ids: it is valid in an email local part (RFC 5322 atext)
// and cannot occur inside a cuid or a uuid.
const SEP = '~';

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret()).update(payload).digest('hex').slice(0, 32);
}

export type ReplyTokenPayload = { relationId: string; recipientUserId: string | null };

export function makeReplyToken(relationId: string, recipientUserId?: string): string {
  const payload = recipientUserId ? `${relationId}${SEP}${recipientUserId}` : relationId;
  return `${payload}.${sign(payload)}`;
}

export function verifyReplyToken(token: string): ReplyTokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  const sep = payload.indexOf(SEP);
  if (sep < 0) return { relationId: payload, recipientUserId: null };
  const relationId = payload.slice(0, sep);
  const recipientUserId = payload.slice(sep + 1);
  // A signed payload can't normally be malformed, but never hand back a blank id.
  if (!relationId || !recipientUserId) return null;
  return { relationId, recipientUserId };
}

// Build the Reply-To for a notification about `relationId` being sent to
// `recipientUserId`. Always pass the recipient — without it, the reply only works
// when they answer from their account address.
export function replyAddress(relationId: string, recipientUserId?: string): string {
  const domain = process.env.INBOUND_EMAIL_DOMAIN || 'crm.ersah.in';
  return `reply+${makeReplyToken(relationId, recipientUserId)}@${domain}`;
}

// Extract the reply token from a recipient address like
// "reply+<token>@domain" (handles display-name wrapped addresses too).
export function extractReplyToken(recipient: string): string | null {
  const m = recipient.match(/reply\+([^@>\s]+)@/i);
  return m ? m[1] : null;
}
