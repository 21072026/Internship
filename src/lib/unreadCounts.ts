import { prisma } from '@/lib/prisma';

/**
 * The two numbers every unread badge in the header is drawn from (#1464).
 *
 * Extracted so the polling endpoint (`GET /api/messages/unread`), the live
 * stream and the stream's own database re-check all count the same rows the same
 * way — a badge that disagrees with itself depending on which path filled it is
 * the bug this whole change is about.
 */
export interface UnreadCounts {
  /** Incoming messages the viewer has not read, across both thread layers. */
  messages: number;
  /** Unread in-app notification rows (the bell). */
  notifications: number;
}

export async function unreadCounts(userId: string): Promise<UnreadCounts> {
  const [messages, notifications] = await Promise.all([
    prisma.message.count({
      where: {
        readAt: null,
        senderId: { not: userId },
        OR: [
          { relation: { OR: [{ mentorId: userId }, { menteeId: userId }] } },
          { conversation: { participants: { some: { userId } } } },
        ],
      },
    }),
    prisma.notification.count({ where: { userId, read: false } }),
  ]);
  return { messages, notifications };
}
