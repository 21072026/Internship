import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { Prisma } from '@prisma/client';
import { notificationCategoryAllowed, type NotificationCategory } from '@/lib/notificationPrefs';

// Interpolation values for the dictionary template keyed by the notification
// `type` (see `notifications.events` in src/i18n/dictionaries.ts). Stored in
// Notification.params and rendered in the recipient's locale at display time,
// so the same row shows up in English, Turkish or German (#921).
export type NotificationParams = Record<string, string | number>;

// Create an in-app notification for a user. Never throws — a failed
// notification must not break the action that triggered it.
export async function notify(userId: string, type: string, params?: NotificationParams, link?: string) {
  try {
    await prisma.notification.create({
      data: { userId, type, params: (params ?? {}) as Prisma.InputJsonValue, link: link ?? null },
    });
  } catch (e) {
    logger.error('Failed to create notification', { userId, type, error: String(e) });
  }
}

// notify() behind the recipient's category preference (#886): the category
// toggles on /account gate in-app rows too, not only e-mail. Fails open — a
// prefs read error must not silence a notification (default is ON anyway).
// Never throws, same as notify().
export async function notifyIfAllowed(
  userId: string,
  category: NotificationCategory,
  type: string,
  params?: NotificationParams,
  link?: string
) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPrefs: true } });
    if (user && !notificationCategoryAllowed(user, category)) return;
  } catch (e) {
    logger.error('Notification pref check failed', { userId, type, error: String(e) });
  }
  await notify(userId, type, params, link);
}
