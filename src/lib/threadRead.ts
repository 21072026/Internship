import { prisma } from '@/lib/prisma';

/**
 * Mark everything `userId` has received in a thread as read (#1204).
 *
 * The rule this encodes: **answering a message is reading it**, and reading the
 * latest message means everything before it in that conversation has been seen
 * too. That is how every chat client behaves, but the app only applied it when
 * the thread was opened in the browser — a reply that arrived by email left
 * `readAt` untouched, so the hourly unread digest kept resurfacing a
 * conversation its recipient had already answered.
 *
 * Only messages *addressed to* this user are touched: their own messages were
 * never unread, and the other participant's read state is none of our business.
 *
 * Both thread layers are covered (#1156): a 1:1 chat lives on the conversation,
 * while `relationId` still annotates the mentorship-scoped features, and a given
 * message may carry either link or both.
 */
export async function markThreadRead(
  userId: string,
  thread: { relationId?: string | null; conversationId?: string | null },
  now: Date = new Date(),
): Promise<number> {
  const links = [
    ...(thread.relationId ? [{ relationId: thread.relationId }] : []),
    ...(thread.conversationId ? [{ conversationId: thread.conversationId }] : []),
  ];
  if (links.length === 0) return 0;

  const { count } = await prisma.message.updateMany({
    where: {
      OR: links,
      senderId: { not: userId },
      readAt: null,
      // Never reach forward past the moment being acted on: a message that
      // lands while the request is in flight is genuinely unread.
      createdAt: { lte: now },
    },
    data: { readAt: now },
  });

  // Conversations also carry a per-participant cursor, which is what drives the
  // in-app unread badge. Leaving it behind would clear the digest but keep the
  // dot in the sidebar.
  if (thread.conversationId) {
    await prisma.conversationParticipant.updateMany({
      where: { conversationId: thread.conversationId, userId, OR: [{ lastReadAt: null }, { lastReadAt: { lt: now } }] },
      data: { lastReadAt: now },
    });
  }

  return count;
}
