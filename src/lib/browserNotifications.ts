// Foreground browser notifications (issue #675, Kademe 1). This is a per-device
// preference: the Notification permission is granted per browser, so the on/off
// toggle lives in localStorage rather than the user's DB profile. Kademe 2
// (background web-push via the service worker) is tracked separately.

export const BROWSER_NOTIF_KEY = 'browserNotifications';

export function canUseBrowserNotifications(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function browserNotificationsEnabled(): boolean {
  if (!canUseBrowserNotifications()) return false;
  try {
    return localStorage.getItem(BROWSER_NOTIF_KEY) === '1' && Notification.permission === 'granted';
  } catch {
    return false;
  }
}

export function setBrowserNotificationsPref(on: boolean): void {
  try {
    localStorage.setItem(BROWSER_NOTIF_KEY, on ? '1' : '0');
  } catch {
    /* storage unavailable — best effort */
  }
}

export function browserNotificationsPrefOn(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(BROWSER_NOTIF_KEY) === '1';
  } catch {
    return false;
  }
}

// Show a foreground notification, honoring the per-device preference + permission.
// Safe to call unconditionally; it no-ops when disabled or unsupported.
export function showBrowserNotification(title: string, body: string, link?: string | null): void {
  if (!browserNotificationsEnabled()) return;
  try {
    const n = new Notification(title, { body, tag: link ?? undefined });
    n.onclick = () => {
      window.focus();
      if (link) window.location.href = link;
      n.close();
    };
  } catch {
    /* some browsers throw if constructed without an active SW in certain contexts */
  }
}
