import { createHmac, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';

// Signed one-click actions for links inside notification emails (#1204).
//
// A notification email is often the only surface someone touches — they read it
// on a phone, answer by replying, and never open the app. Until now the only
// action it offered was "reply", so a conversation stayed unread forever and the
// digest kept resurfacing messages that had already been answered.
//
// These tokens carry the action, its target and the user it was minted for,
// signed with the server secret — the same construction (and the same trust
// argument) as the Reply-To tokens in src/lib/replyToken.ts: the link is only
// ever delivered to that user's registered address, so honouring it grants
// nothing a mailbox holder could not already get from a password reset.
//
// Tokens expire after 90 days. Long enough that a digest opened weeks later
// still works, short enough that the exposure window closes: a notification
// email that gets forwarded, or an old mailbox archive that leaks, would
// otherwise let someone act as that user forever. Both actions are low-severity
// and reversible (a reaction, a read flag — never a message), which is why this
// is 90 days and not 24 hours.
export const EMAIL_ACTION_TTL_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;
// Days since the epoch, base36 — a compact, ASCII, sortable stamp. Day
// granularity is plenty for a 90-day window and keeps the token short.
const today = () => Math.floor(Date.now() / DAY_MS);

// Mirrors REACTION_EMOJIS in src/app/api/messages/[id]/reactions/route.ts. The
// token stores the *index*, never the emoji itself, so a token can never carry
// an arbitrary string into the database and the URL stays ASCII.
export const EMAIL_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '🎉'] as const;
export type ReactionEmoji = (typeof EMAIL_REACTION_EMOJIS)[number];

export type EmailAction =
  // Mark everything the user has received in this thread as read.
  | { kind: 'read'; relationId: string; userId: string }
  // React to one specific message. Bound to the message id rather than "the
  // newest in the thread" so a reply arriving between send and click cannot
  // redirect the reaction onto the wrong message.
  | { kind: 'react'; messageId: string; userId: string; emojiIndex: number };

// `~` separates the fields and `.` separates payload from signature (as in
// replyToken). `~` specifically because the token is a URL *path* segment:
// it is an RFC 3986 unreserved character, so it survives a round trip through
// the browser and the router untouched. A `|` here silently broke every link —
// it has to be percent-encoded, and the encoded form did not always come back
// out of the route param intact. Neither character can occur in a cuid.
const SEP = '~';

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret()).update(payload).digest('hex').slice(0, 32);
}

function serialize(action: EmailAction, day: number): string {
  const stamp = day.toString(36);
  return action.kind === 'read'
    ? ['k', action.relationId, action.userId, stamp].join(SEP)
    : ['r', action.messageId, action.userId, String(action.emojiIndex), stamp].join(SEP);
}

export function makeEmailActionToken(action: EmailAction, day: number = today()): string {
  const payload = serialize(action, day);
  return `${payload}.${sign(payload)}`;
}

/**
 * `null` when the signature does not verify or the payload is malformed;
 * `'expired'` when it verifies but is older than the TTL — the caller turns
 * that into "this link has expired, open it in the app" rather than the
 * misleading "invalid link".
 */
export function verifyEmailActionToken(token: string): EmailAction | 'expired' | null {
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

  const parts = payload.split(SEP);

  // The stamp is the last field of both shapes. Checked before the action is
  // returned, so an expired token can never reach the handler.
  const expired = (stamp: string) => {
    const issued = parseInt(stamp, 36);
    return !Number.isFinite(issued) || today() - issued > EMAIL_ACTION_TTL_DAYS;
  };

  if (parts[0] === 'k' && parts.length === 4) {
    const [, relationId, userId, stamp] = parts;
    if (!relationId || !userId) return null;
    if (expired(stamp)) return 'expired';
    return { kind: 'read', relationId, userId };
  }
  if (parts[0] === 'r' && parts.length === 5) {
    const [, messageId, userId, rawIndex, stamp] = parts;
    const emojiIndex = Number(rawIndex);
    // A signed payload cannot normally be malformed, but never hand back an
    // index that would read past the emoji table.
    if (!messageId || !userId) return null;
    if (!Number.isInteger(emojiIndex) || emojiIndex < 0 || emojiIndex >= EMAIL_REACTION_EMOJIS.length) return null;
    if (expired(stamp)) return 'expired';
    return { kind: 'react', messageId, userId, emojiIndex };
  }
  return null;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/**
 * The URL an email link points at. It resolves to a *page*, not an API route,
 * on purpose: mail clients and corporate link scanners (Outlook Safe Links,
 * antivirus gateways) prefetch every URL in a message, so a GET that mutates
 * state would fire a reaction nobody clicked. The page performs the action from
 * the browser instead, and scanners do not run scripts.
 */
export function emailActionUrl(action: EmailAction): string {
  return `${appUrl()}/m/${encodeURIComponent(makeEmailActionToken(action))}`;
}

/** "Mark this conversation as read" link for a notification or digest email. */
export function markReadUrl(relationId: string, userId: string): string {
  return emailActionUrl({ kind: 'read', relationId, userId });
}

/**
 * The row of one-click reaction links shown under a message in an email — the
 * same five emoji the in-app composer offers, so reacting from the inbox and
 * reacting in the app produce the same thing.
 */
export function reactionLinksHtml(messageId: string, userId: string): string {
  const links = EMAIL_REACTION_EMOJIS.map((emoji, emojiIndex) => {
    const url = emailActionUrl({ kind: 'react', messageId, userId, emojiIndex });
    return `<a href="${url}" style="text-decoration:none;font-size:20px;padding:4px 6px;" title="${emoji}">${emoji}</a>`;
  }).join('');
  return `<div style="margin:8px 0;">${links}</div>`;
}
