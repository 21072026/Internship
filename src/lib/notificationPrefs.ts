// Email notification categories a user can individually opt out of.
export const NOTIFICATION_CATEGORIES = ['messages', 'announcements', 'deadlines', 'digest', 'meetingReminders'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

interface PrefUser {
  emailNotifications?: boolean | null;
  notificationPrefs?: unknown;
}

// Whether to send a transactional email of the given category to a user.
// The master switch (emailNotifications) wins; otherwise the per-category
// preference applies, defaulting to ON when unset.
export function emailAllowed(user: PrefUser, category: NotificationCategory): boolean {
  if (user.emailNotifications === false) return false;
  const prefs = (user.notificationPrefs && typeof user.notificationPrefs === 'object')
    ? (user.notificationPrefs as Record<string, unknown>)
    : {};
  return prefs[category] !== false;
}
