import { createHmac, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';
import { inboundEmailDomain } from '@/lib/inboundDomain';

export { inboundEmailDomain };

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
//
// A CONVERSATION target (#1713) — a project group chat, or a direct chat with
// no mentorship behind it — is `c=<conversationId>~<recipientUserId>`. `=` has
// the same two properties as `~` (atext; never inside a cuid/uuid), so no
// relation token can be read as a conversation one or vice versa. A
// conversation token always names its recipient. It names, it does not grant:
// the inbound path re-checks the sender's right to post with
// `canPostToConversation()` at write time.
const SEP = '~';
const CONVERSATION_PREFIX = 'c=';

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret()).update(payload).digest('hex').slice(0, 32);
}

export type ReplyTokenPayload =
  | { kind: 'relation'; relationId: string; recipientUserId: string | null }
  | { kind: 'conversation'; conversationId: string; recipientUserId: string };

export function makeReplyToken(relationId: string, recipientUserId?: string): string {
  const payload = recipientUserId ? `${relationId}${SEP}${recipientUserId}` : relationId;
  return `${payload}.${sign(payload)}`;
}

export function makeConversationReplyToken(conversationId: string, recipientUserId: string): string {
  const payload = `${CONVERSATION_PREFIX}${conversationId}${SEP}${recipientUserId}`;
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

  if (payload.startsWith(CONVERSATION_PREFIX)) {
    const rest = payload.slice(CONVERSATION_PREFIX.length);
    const sep = rest.indexOf(SEP);
    const conversationId = sep < 0 ? '' : rest.slice(0, sep);
    const recipientUserId = sep < 0 ? '' : rest.slice(sep + 1);
    if (!conversationId || !recipientUserId) return null;
    return { kind: 'conversation', conversationId, recipientUserId };
  }
  const sep = payload.indexOf(SEP);
  if (sep < 0) return { kind: 'relation', relationId: payload, recipientUserId: null };
  const relationId = payload.slice(0, sep);
  const recipientUserId = payload.slice(sep + 1);
  // A signed payload can't normally be malformed, but never hand back a blank id.
  if (!relationId || !recipientUserId) return null;
  return { kind: 'relation', relationId, recipientUserId };
}

// Build the Reply-To for a notification about `relationId` being sent to
// `recipientUserId`. Always pass the recipient — without it, the reply only works
// when they answer from their account address. `undefined` when reply-by-email
// is not configured: the mail then goes out without a Reply-To, and the copy
// that invites a reply must check first (see `/api/messages`).
export function replyAddress(relationId: string, recipientUserId?: string): string | undefined {
  const domain = inboundEmailDomain();
  if (!domain) return undefined;
  return `reply+${makeReplyToken(relationId, recipientUserId)}@${domain}`;
}

// The Reply-To for a conversation thread with no mentorship behind it (#1713).
export function conversationReplyAddress(conversationId: string, recipientUserId: string): string | undefined {
  const domain = inboundEmailDomain();
  if (!domain) return undefined;
  return `reply+${makeConversationReplyToken(conversationId, recipientUserId)}@${domain}`;
}

// Extract the reply token from a recipient address like
// "reply+<token>@domain" (handles display-name wrapped addresses too).
export function extractReplyToken(recipient: string): string | null {
  const m = recipient.match(/reply\+([^@>\s]+)@/i);
  return m ? m[1] : null;
}
