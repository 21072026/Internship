// Notification categories a user can individually opt out of. A category
// switch applies to every channel that carries the category — e-mail AND
// in-app rows (#886, via notifyIfAllowed) — while emailNotifications below
// stays an e-mail-only master switch.
// 'newsletter' (#1469) is the one category a reader is expected to turn off on
// its own: the career-tips issues are the only mail here that is content rather
// than something happening in their pipeline. Switching it off must never
// silence a message, a meeting reminder or a stage update — which is exactly
// why it is its own category and not folded into 'announcements'.
export const NOTIFICATION_CATEGORIES = ['messages', 'announcements', 'deadlines', 'digest', 'meetingReminders', 'mentorship', 'documents', 'weeklyReports', 'interactions', 'goalsEvaluations', 'stageUpdates', 'newsletter'] as const;
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
