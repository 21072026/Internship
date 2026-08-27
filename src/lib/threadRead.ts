import { prisma } from '@/lib/prisma';
import { markThreadNotificationsRead } from '@/lib/messageNotifications';
import { publishRealtime } from '@/lib/realtimeBus';

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
 *
 * Reading a thread also retires the notification rows it produced (#1464). The
 * blue "new message from X" row in the bell is the *same fact* as the red counter
 * in the inbox, so clearing one and not the other is what made the unread badge
 * look stuck after the message had been read and answered. Doing it here rather
 * than in the messages route means every way of reading a thread — opening it,
 * answering by e-mail, the "mark as read" link in the notification mail — clears
 * both signals.
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

  // The bell's unread rows for this thread are the same fact as the counters
  // above — see the note in messageNotifications.ts.
  const notificationsCleared = await markThreadNotificationsRead(userId, thread);

  // Tell this user's other open tabs, so their badges drop now instead of on the
  // next heartbeat. Addressed to the reader alone: nobody else's view changed.
  //
  // Only when something actually moved: a thread that is open re-reads itself on
  // every live signal and every poll tick, and publishing "I read it" each time
  // would spend a pair of COUNT queries per tick per open tab to announce that
  // nothing changed.
  if (count > 0 || notificationsCleared > 0) {
    publishRealtime([userId], {
      type: 'read',
      relationId: thread.relationId ?? null,
      conversationId: thread.conversationId ?? null,
    });
  }

  return count;
}
