import { prisma } from '@/lib/prisma';

/**
 * Clearing the *notification* rows a thread produced (#1464).
 *
 * Two independent unread signals exist for the same event: `Message.readAt` /
 * `ConversationParticipant.lastReadAt` (the red counters in the inbox and the
 * header) and the `Notification` row `notify()` wrote (the blue unread icon and
 * dot in the bell and on /notifications). Opening a thread only ever cleared the
 * first one, so the blue "new message from X" row survived reading the message
 * — and replying to it — until the reader happened to open the bell. That looked
 * like a stuck badge, because it is one: the two signals describe the same fact.
 *
 * A notification is matched by its `link`, which is the thread URL `notify()`
 * was given (see the POST handler in src/app/api/messages/route.ts). Matching on
 * the link rather than adding a `threadId` column keeps this working for the rows
 * already sitting in everyone's bell, in both link shapes a 1:1 thread has had
 * (`/messages/<relationId>` before #1156, `/messages/c/<conversationId>` after).
 */

// Every notification type a new message can produce. Enumerated rather than a
// `startsWith('message.')` LIKE so a future `message.*` type has to opt in
// deliberately — and so the query stays a plain indexed IN.
export const MESSAGE_NOTIFICATION_TYPES = ['message.new', 'message.newGeneric', 'message.newByEmail'] as const;

// The support conversation is a thread too (#593), with its own pinned row in the
// inbox and its own notification types.
export const SUPPORT_NOTIFICATION_TYPES = ['support.replied', 'support.closed'] as const;

/**
 * Mark this user's unread message notifications for one thread as read.
 *
 * Both link shapes are cleared whenever both ids are known: a 1:1 thread is
 * reachable as a mentorship *and* as a conversation, and which one a given
 * notification carries depends on when it was written.
 */
export async function markThreadNotificationsRead(
  userId: string,
  thread: { relationId?: string | null; conversationId?: string | null },
): Promise<number> {
  const links = [
    ...(thread.conversationId ? [`/messages/c/${thread.conversationId}`] : []),
    ...(thread.relationId ? [`/messages/${thread.relationId}`] : []),
  ];
  if (links.length === 0) return 0;

  const { count } = await prisma.notification.updateMany({
    where: {
      userId,
      read: false,
      type: { in: [...MESSAGE_NOTIFICATION_TYPES] },
      link: { in: links },
    },
    data: { read: true },
  });
  return count;
}

/** The same rule for the pinned support thread, whose link is a fixed path. */
export async function markSupportNotificationsRead(userId: string): Promise<number> {
  const { count } = await prisma.notification.updateMany({
    where: {
      userId,
      read: false,
      type: { in: [...SUPPORT_NOTIFICATION_TYPES] },
      link: '/messages/support',
    },
    data: { read: true },
  });
  return count;
}
