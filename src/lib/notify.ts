import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';

// Create an in-app notification for a user. Never throws — a failed
// notification must not break the action that triggered it.
export async function notify(userId: string, type: string, text: string, link?: string) {
  try {
    await prisma.notification.create({ data: { userId, type, text, link: link ?? null } });
  } catch (e) {
    logger.error('Failed to create notification', { userId, type, error: String(e) });
  }
}
