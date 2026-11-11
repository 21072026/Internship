import { prisma } from '@/lib/prisma';
import { scanMessageForSafeguarding } from '@/lib/safeguardingScan';
import { notificationCategoryAllowed } from '@/lib/notificationPrefs';
import { canPostToConversation, conversationForRelation, mutedParticipants, otherConversationParticipants } from '@/lib/conversations';
import { verifyReplyToken, extractReplyToken } from '@/lib/replyToken';
import { notify } from '@/lib/notify';
import { notifyEvent } from '@/lib/notifications/router';
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
  // Read by the BCC-to-CRM path only (src/lib/crmBcc.ts, #2809); a thread
  // reply ignores them.
  /** The Cc header, so a customer copied rather than addressed still matches. */
  cc?: string | null;
  subject?: string | null;
  /** The mail's Date header (RFC 2822 or ISO). */
  date?: string | null;
  /**
   * A message forwarded AS AN ATTACHMENT (`message/rfc822`), read by the bridge
   * (#2815). An inline forward needs nothing here: its header block is read
   * from `text`.
   */
  forwarded?: { from: string; date: string | null; subject: string | null; messageId: string | null } | null;
};

export type InboundResult =
  | { ok: true; relationId: string | null; conversationId?: string | null; duplicate: boolean }
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
  if (payload.kind === 'conversation') return routeConversationReply(input, payload.conversationId, payload.recipientUserId);
  const { relationId, recipientUserId } = payload;

  const rel = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    include: {
      // notificationPrefs so the in-app reply notification can honour the
      // recipient's "Messages" category (#1426).
      mentor: { select: { id: true, email: true, notificationPrefs: true } },
      mentee: { select: { id: true, email: true, notificationPrefs: true } },
    },
  });
  if (!rel) return { ok: false, status: 404, reason: 'Thread not found' };

  // Who wrote this? Preferred: the From address is one of the two participants.
  //
  // WORLDS (#2590). One person can hold an account in each product under the
  // SAME address, so "the account this address belongs to" is ambiguous — and
  // nothing below asks it. The reply is anchored by the signed TOKEN first: it
  // names one relationship (`relationId`) and the one participant it was sent to
  // (`recipientUserId`), and both are user/relation IDS. The sender is then
  // matched against only that relationship's two participants — who are, by the
  // tenant model, both in the relationship's own organization and therefore in
  // one world. A person's account in the other product is not on this
  // relationship and cannot be picked; there is no `user.findFirst({ where: {
  // email } })` on this path to pick the wrong row, and none may be added — the
  // address alone must never decide which account (or which product) a reply
  // belongs to. The fallback further down is likewise by token, not by address.
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
  let storedId: string;
  try {
    storedId = (
      await prisma.message.create({
        data: { relationId, conversationId: conversation?.id ?? null, senderId, channel: 'EMAIL', body, inboundMessageId },
        select: { id: true },
      })
    ).id;
  } catch (e) {
    // Unique violation on inboundMessageId — another tick won the race.
    if (inboundMessageId && (e as { code?: string }).code === 'P2002') {
      return { ok: true, relationId, duplicate: true };
    }
    throw e;
  }

  // Safeguarding (#2056): an e-mailed reply is checked for watch keywords only —
  // every mail carries a signature, so its contact details are not flagged.
  await scanMessageForSafeguarding({ messageId: storedId, body, senderId, arrivedByEmail: true });

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

  const recipientUser = senderId === rel.mentor.id ? rel.mentee : rel.mentor;
  const link = conversation ? `/messages/c/${conversation.id}` : `/messages/${relationId}`;
  // An emailed reply is still a message, so it belongs to the same category
  // (#1426). Someone who switched Messages off has said they do not want the
  // bell for this conversation, whichever door the reply came through — and
  // that goes for the background push as well (#1464), which is why it sits
  // inside the same gate. The router re-checks the preference itself (and
  // records why it skipped), so this is about not doing the work.
  // A thread the recipient muted (#1609) interrupts them through no door.
  const muted = await mutedParticipants(conversation?.id, [recipientUser.id]);
  if (notificationCategoryAllowed(recipientUser, 'messages') && !muted.has(recipientUser.id)) {
    await notify(recipientUser.id, 'message.newByEmail', {}, link);
    await notifyEvent(
      recipientUser.id,
      'message.newByEmail',
      conversation ? { conversationId: conversation.id } : { relationId },
      { channels: ['push'], preview: body, dedupeKey: `message:${storedId}` },
    );
  }

  return { ok: true, relationId, duplicate: false };
}

/**
 * A reply to a conversation thread with no mentorship behind it — a project
 * group chat, or a direct chat between two people who share a project (#1713).
 *
 * The same policy as the relation path, applied to the conversation's own
 * participants: the sender is the participant whose address is the `From`, else
 * the participant the signed token was sent to (logged, the weaker signal). The
 * token NAMES; it never grants. The right to post is re-checked now, with the
 * same `canPostToConversation()` the in-app composer uses — someone removed from
 * the project since the mail went out is refused with 403. As on the relation
 * path, no account is ever looked up by address: only this conversation's
 * participants can be picked (docs/worlds.md).
 */
async function routeConversationReply(input: InboundEmail, conversationId: string, recipientUserId: string): Promise<InboundResult> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      type: true,
      projectId: true,
      participants: { select: { userId: true, user: { select: { id: true, email: true, role: true, orgId: true } } } },
    },
  });
  if (!conversation) return { ok: false, status: 404, reason: 'Thread not found' };

  const from = emailOf(input.from);
  const byFrom = conversation.participants.find((p) => p.user.email.toLowerCase() === from);
  let sender = byFrom?.user ?? null;
  if (!sender) {
    const named = conversation.participants.find((p) => p.userId === recipientUserId);
    if (named) {
      sender = named.user;
      logger.info('Inbound reply attributed via reply token, not From', { conversationId, from, senderId: sender.id });
    }
  }
  if (!sender || !(await canPostToConversation({ id: sender.id, role: sender.role, orgId: sender.orgId }, conversation))) {
    logger.warning('Inbound email from non-participant rejected', { conversationId, from });
    return { ok: false, status: 403, reason: 'Sender is not a participant' };
  }
  const senderId = sender.id;

  const inboundMessageId = input.messageId?.trim() || null;
  if (inboundMessageId) {
    const seen = await prisma.message.findUnique({ where: { inboundMessageId } });
    if (seen) return { ok: true, relationId: null, conversationId, duplicate: true };
  }

  const body = stripQuoted(input.text ?? '') || '(empty message)';
  let storedId: string;
  try {
    storedId = (
      await prisma.message.create({
        data: { conversationId, senderId, channel: 'EMAIL', body, inboundMessageId },
        select: { id: true },
      })
    ).id;
  } catch (e) {
    if (inboundMessageId && (e as { code?: string }).code === 'P2002') {
      return { ok: true, relationId: null, conversationId, duplicate: true };
    }
    throw e;
  }

  await scanMessageForSafeguarding({ messageId: storedId, body, senderId, arrivedByEmail: true });
  try {
    await markThreadRead(senderId, { conversationId });
  } catch (e) {
    logger.error('Failed to mark thread read after inbound reply', { conversationId, senderId, error: String(e) });
  }

  // Everyone else in the room, minus a member who left the project and anyone
  // who muted the thread — the same audience as a message typed in the app.
  const others = await otherConversationParticipants(conversation, senderId);
  const muted = await mutedParticipants(conversationId, others);
  const prefs = await prisma.user.findMany({ where: { id: { in: others } }, select: { id: true, notificationPrefs: true } });
  const link = `/messages/c/${conversationId}`;
  for (const r of prefs) {
    if (muted.has(r.id) || !notificationCategoryAllowed(r, 'messages')) continue;
    await notify(r.id, 'message.newByEmail', {}, link);
    await notifyEvent(r.id, 'message.newByEmail', { conversationId }, {
      channels: ['push'],
      preview: body,
      dedupeKey: `message:${storedId}`,
    });
  }

  return { ok: true, relationId: null, conversationId, duplicate: false };
}
