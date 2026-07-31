import { prisma } from '@/lib/prisma';
import { verifyReplyToken, extractReplyToken } from '@/lib/replyToken';
import { notify } from '@/lib/notify';
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
export function stripQuoted(text: string): string {
  const cut = text.search(/^\s*(On .+ wrote:|-{2,} ?Original Message|>)/m);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

export async function routeInboundEmail(input: InboundEmail): Promise<InboundResult> {
  const token = extractReplyToken(input.to);
  const relationId = token && verifyReplyToken(token);
  if (!relationId) return { ok: false, status: 400, reason: 'No valid reply token' };

  const rel = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    include: { mentor: { select: { id: true, email: true } }, mentee: { select: { id: true, email: true } } },
  });
  if (!rel) return { ok: false, status: 404, reason: 'Thread not found' };

  // The sender must be a participant of this thread.
  const from = emailOf(input.from);
  const senderId = from === rel.mentor.email.toLowerCase() ? rel.mentor.id
    : from === rel.mentee.email.toLowerCase() ? rel.mentee.id
    : null;
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
  try {
    await prisma.message.create({ data: { relationId, senderId, channel: 'EMAIL', body, inboundMessageId } });
  } catch (e) {
    // Unique violation on inboundMessageId — another tick won the race.
    if (inboundMessageId && (e as { code?: string }).code === 'P2002') {
      return { ok: true, relationId, duplicate: true };
    }
    throw e;
  }

  const recipient = senderId === rel.mentor.id ? rel.mentee.id : rel.mentor.id;
  await notify(recipient, 'message', 'New message (by email).', `/messages/${relationId}`);

  return { ok: true, relationId, duplicate: false };
}
