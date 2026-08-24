// Notification categories a user can individually opt out of. A category
// switch applies to every channel that carries the category — e-mail AND
// in-app rows (#886, via notifyIfAllowed) — while emailNotifications below
// stays an e-mail-only master switch.
export const NOTIFICATION_CATEGORIES = ['messages', 'announcements', 'deadlines', 'digest', 'meetingReminders', 'mentorship', 'documents', 'weeklyReports', 'interactions', 'goalsEvaluations', 'stageUpdates'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

interface PrefUser {
  emailNotifications?: boolean | null;
  notificationPrefs?: unknown;
}

// Category switches apply to every notification channel that belongs to the
// category. Channel-specific master switches (currently emailNotifications)
// are layered on top by the channel helper below.
export function notificationCategoryAllowed(user: Pick<PrefUser, 'notificationPrefs'>, category: NotificationCategory): boolean {
  const prefs = (user.notificationPrefs && typeof user.notificationPrefs === 'object')
    ? (user.notificationPrefs as Record<string, unknown>)
    : {};
  return prefs[category] !== false;
}

// Whether to send a transactional email of the given category to a user.
// The master switch (emailNotifications) wins; otherwise the per-category
// preference applies, defaulting to ON when unset.
export function emailAllowed(user: PrefUser, category: NotificationCategory): boolean {
  if (user.emailNotifications === false) return false;
  return notificationCategoryAllowed(user, category);
}
