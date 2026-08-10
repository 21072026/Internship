import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { markThreadRead } from '@/lib/threadRead';
import { conversationForRelation } from '@/lib/conversations';
import { verifyEmailActionToken, EMAIL_REACTION_EMOJIS } from '@/lib/emailActionToken';
import { logger } from '@/lib/logger';

// One-click actions from a notification email (#1204): "mark as read" and the
// five emoji reactions. No session — the signed token is the credential, the
// same trust model as the Reply-To tokens and the RSVP links.
//
// POST, not GET, deliberately: mail clients and corporate link scanners
// prefetch every URL in a message, and a mutating GET would post reactions
// nobody clicked. The email links to /m/<token>, which performs this call from
// the browser.

const schema = z.object({ token: z.string().min(1).max(512) });

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, 'email-action', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  const action = verifyEmailActionToken(parsed.data.token);
  // 410 Gone, not 400: the link was genuine, it just aged out. The page shows
  // "open it in the app" instead of the misleading "invalid link".
  if (action === 'expired') {
    return NextResponse.json({ error: 'expired', expired: true }, { status: 410 });
  }
  if (!action) return NextResponse.json({ error: 'This link is not valid.' }, { status: 400 });

  // The token names a user, but it was minted long ago — confirm the account
  // still exists and is usable before acting for them.
  const user = await prisma.user.findUnique({
    where: { id: action.userId },
    select: { id: true, isActive: true },
  });
  if (!user || !user.isActive) {
    return NextResponse.json({ error: 'This account is no longer active.' }, { status: 403 });
  }

  if (action.kind === 'read') {
    const rel = await prisma.mentorshipRelation.findUnique({
      where: { id: action.relationId },
      select: { id: true, mentorId: true, menteeId: true },
    });
    if (!rel) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
    if (rel.mentorId !== user.id && rel.menteeId !== user.id) {
      return NextResponse.json({ error: 'Not your conversation.' }, { status: 403 });
    }

    const conversation = await conversationForRelation(rel);
    const marked = await markThreadRead(user.id, {
      relationId: rel.id,
      conversationId: conversation?.id ?? null,
    });
    return NextResponse.json({ ok: true, kind: 'read', marked });
  }

  // Reaction. Authorization is participation in the message's thread, resolved
  // from the message itself rather than trusted from the token.
  const message = await prisma.message.findUnique({
    where: { id: action.messageId },
    select: {
      id: true,
      relationId: true,
      conversationId: true,
      deletedForEveryoneAt: true,
      relation: { select: { mentorId: true, menteeId: true } },
      conversation: { select: { participants: { select: { userId: true } } } },
    },
  });
  if (!message) return NextResponse.json({ error: 'Message not found.' }, { status: 404 });
  if (message.deletedForEveryoneAt) {
    return NextResponse.json({ error: 'That message was deleted.' }, { status: 409 });
  }

  const isParticipant =
    message.relation?.mentorId === user.id ||
    message.relation?.menteeId === user.id ||
    (message.conversation?.participants ?? []).some((p) => p.userId === user.id);
  if (!isParticipant) return NextResponse.json({ error: 'Not your conversation.' }, { status: 403 });

  const emoji = EMAIL_REACTION_EMOJIS[action.emojiIndex];
  const key = { messageId_userId_emoji: { messageId: message.id, userId: user.id, emoji } };

  // Same semantics as the in-app endpoint: one reaction per user per message,
  // clicking the same emoji again removes it. Clicking twice from an email is
  // more likely a double-tap than a deliberate toggle, but keeping the two
  // paths identical matters more than guessing.
  const existing = await prisma.messageReaction.findUnique({ where: key });
  if (existing) {
    await prisma.messageReaction.delete({ where: key });
    return NextResponse.json({ ok: true, kind: 'react', emoji, active: false });
  }
  await prisma.$transaction([
    prisma.messageReaction.deleteMany({ where: { messageId: message.id, userId: user.id } }),
    prisma.messageReaction.create({ data: { messageId: message.id, userId: user.id, emoji } }),
  ]);

  // Reacting is also reading — you cannot react to something you have not seen,
  // and leaving the thread unread would put it straight back in the digest.
  try {
    await markThreadRead(user.id, { relationId: message.relationId, conversationId: message.conversationId });
  } catch (e) {
    logger.error('Failed to mark thread read after email reaction', { messageId: message.id, error: String(e) });
  }

  return NextResponse.json({ ok: true, kind: 'react', emoji, active: true });
}
