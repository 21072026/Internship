import { prisma } from '@/lib/prisma';
import { conversationForRelation } from '@/lib/conversations';
import { verifyReplyToken, extractReplyToken } from '@/lib/replyToken';
import { notify } from '@/lib/notify';
import { sendNewMessagePush } from '@/lib/messagePush';
import { markThreadRead } from '@/lib/threadRead';
import { logger } from '@/lib/logger';

// Routing for an inbound email reply. Shared by the HTTP endpoint
// (`POST /api/inbound-email`, used by provider webhooks and the backfill
// script) and by the IMAP bridge (`src/services/inboundMailBridge.ts`), so both
// paths apply exactly the same token + participant checks.

export type InboundEmail = {
  to: string;
  from: string;
  text?: string;
  /** RFC Message-ID, when known. Used to make delivery idempotent. */
  messageId?: string | null;
};

export type InboundResult =
  | { ok: true; relationId: string; duplicate: boolean }
  | { ok: false; status: 400 | 403 | 404; reason: string };

export const emailOf = (s: string) => (s.match(/[^<>\s]+@[^<>\s]+/)?.[0] || s).trim().toLowerCase();

// Strip a quoted reply history (best-effort) so only the new text is kept.
//
// The attribution line clients put above the quote varies more than the old
// `On … wrote:` pattern allowed — a real reply arrived as
// "July 2, 2026 at 3:50 PM, noreply@crm.ersah.in wrote:", which matched nothing
// and leaked into the thread. So: cut at any line that *ends* in the local
// "wrote:" verb (EN/TR/DE, the app's locales), at an Outlook divider, or at the
// first quoted `>` line — whichever comes first.
const QUOTE_START = /^\s*(.*\b(wrote|yazdı|schrieb):\s*$|-{2,} ?Original Message|_{10,}|>)/m;

export function stripQuoted(text: string): string {
  const cut = text.search(QUOTE_START);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

export async function routeInboundEmail(input: InboundEmail): Promise<InboundResult> {
  const token = extractReplyToken(input.to);
  const payload = token ? verifyReplyToken(token) : null;
  if (!payload) return { ok: false, status: 400, reason: 'No valid reply token' };
  const { relationId, recipientUserId } = payload;

  const rel = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    include: { mentor: { select: { id: true, email: true } }, mentee: { select: { id: true, email: true } } },
  });
  if (!rel) return { ok: false, status: 404, reason: 'Thread not found' };

  // Who wrote this? Preferred: the From address is one of the two participants.
  const from = emailOf(input.from);
  let senderId = from === rel.mentor.email.toLowerCase() ? rel.mentor.id
    : from === rel.mentee.email.toLowerCase() ? rel.mentee.id
    : null;

  // Otherwise fall back to the recipient named in the signed token. People read
  // mail forwarded to a personal account and reply with *that* identity, so the
  // From address often isn't the one on their profile — which used to drop the
  // reply. The token was only ever delivered to this user's registered address,
  // so honouring it grants nothing a mailbox holder couldn't already get from a
  // password reset. Logged, because it is the weaker of the two signals.
  if (!senderId && recipientUserId && (recipientUserId === rel.mentor.id || recipientUserId === rel.mentee.id)) {
    senderId = recipientUserId;
    logger.info('Inbound reply attributed via reply token, not From', { relationId, from, senderId });
  }

  if (!senderId) {
    logger.warning('Inbound email from non-participant rejected', { relationId, from });
    return { ok: false, status: 403, reason: 'Sender is not a participant' };
  }

  // IMAP delivery is at-least-once (a crash between storing and flagging the
  // mail replays it), so the RFC Message-ID guards against a double post.
  const inboundMessageId = input.messageId?.trim() || null;
  if (inboundMessageId) {
    const seen = await prisma.message.findUnique({ where: { inboundMessageId } });
    if (seen) return { ok: true, relationId, duplicate: true };
  }

  const body = stripQuoted(input.text ?? '') || '(empty message)';
  // The reply belongs in the pair's one thread, not only on the mentorship it
  // was addressed to (#1156) — otherwise an emailed answer never shows up in the
  // chat the two of them are actually reading.
  const conversation = await conversationForRelation(rel);
  try {
    await prisma.message.create({
      data: { relationId, conversationId: conversation?.id ?? null, senderId, channel: 'EMAIL', body, inboundMessageId },
    });
  } catch (e) {
    // Unique violation on inboundMessageId — another tick won the race.
    if (inboundMessageId && (e as { code?: string }).code === 'P2002') {
      return { ok: true, relationId, duplicate: true };
    }
    throw e;
  }

  // Answering IS reading (#1204). Without this the replier's own inbox kept
  // being told about messages they had already responded to: the reply landed
  // in the thread but `readAt` stayed null, so the hourly unread digest picked
  // the same conversation up again and again.
  try {
    const marked = await markThreadRead(senderId, { relationId, conversationId: conversation?.id ?? null });
    if (marked > 0) logger.info('Inbound reply marked thread read', { relationId, senderId, marked });
  } catch (e) {
    // Never fail a delivered reply over its read bookkeeping — the message is
    // already stored, and the worst case is one more digest line.
    logger.error('Failed to mark thread read after inbound reply', { relationId, senderId, error: String(e) });
  }

  const recipient = senderId === rel.mentor.id ? rel.mentee.id : rel.mentor.id;
  const link = conversation ? `/messages/c/${conversation.id}` : `/messages/${relationId}`;
  await notify(recipient, 'message.newByEmail', {}, link);
  // A message relayed in from e-mail is still a new message (#1464), so it earns
  // the same background push as one written in the app.
  await sendNewMessagePush(recipient, { link, byEmail: true, preview: body });

  return { ok: true, relationId, duplicate: false };
}
