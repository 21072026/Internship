// Native notifications (#2775): the shape GET /api/notifications answers with,
// and the one rule for what a tap opens. Dependency-free so `npm test` pins it.

export interface NotificationItem {
  id: string;
  type: string;
  /** Rendered server-side in the reader's locale and vertical (src/lib/notificationText.ts). */
  display: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationItem[];
  unread: number;
  total: number;
  page: number;
  pageSize: number;
}

export const PAGE_SIZE = 20;

export function notificationsPath(page: number, onlyUnread = false): string {
  const q = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (onlyUnread) q.set('read', 'unread');
  return `/api/notifications?${q.toString()}`;
}

export function hasMore(p: Pick<NotificationPage, 'page' | 'pageSize' | 'total'>): boolean {
  return p.page * p.pageSize < p.total;
}

/**
 * The in-app path a notification opens, or null. Only a same-site PATH is
 * honoured: a row's link is data, and the web view only ever loads the
 * product's own origin — an absolute or protocol-relative link opens nothing.
 */
export function notificationTarget(link: string | null | undefined): string | null {
  if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//')) return null;
  return link;
}

/** Merge a fetched page into the list, newest first, without duplicates. */
export function mergePage(current: NotificationItem[], incoming: NotificationItem[], replace: boolean): NotificationItem[] {
  if (replace) return incoming;
  const seen = new Set(current.map((n) => n.id));
  return [...current, ...incoming.filter((n) => !seen.has(n.id))];
}
