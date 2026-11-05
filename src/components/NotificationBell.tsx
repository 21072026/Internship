'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { showBrowserNotification } from '@/lib/browserNotifications';
import { NotificationTypeIcon } from '@/components/NotificationTypeIcon';
import { renderNotification } from '@/lib/notificationText';
import { markAllReadLocally, useNotificationFeed, type FeedNote } from '@/components/notificationFeed';

export function NotificationBell() {
  const t = useT();
  const locale = useLocale();
  const { status } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // One feed for every bell on the page (#3573): the shell mounts two (mobile
  // bar + desktop strip), which used to mean two fetches, two pollers and two
  // browser popups per new row. src/components/notificationFeed.ts owns the
  // fetching; a bell only renders the shared snapshot.
  const onNew = useCallback(
    (n: FeedNote) => showBrowserNotification(t.notifications.title, renderNotification(n, t, locale), n.link),
    [t, locale],
  );
  const { items, unread } = useNotificationFeed(status === 'authenticated', onNew);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (status !== 'authenticated') return null;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && unread > 0) {
      await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      markAllReadLocally();
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        // The badge's text must be part of the accessible name (WCAG 2.5.3 label in name).
        aria-label={unread > 0 ? `${t.notifications.title} ${unread > 9 ? '9+' : unread}` : t.notifications.title}
        className="relative min-h-11 min-w-11 flex items-center justify-center text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 rounded-full"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span
            data-testid="notifications-unread-badge"
            className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg z-50">
          <div className="px-4 py-2 border-b border-gray-100 text-sm font-semibold text-gray-700">{t.notifications.title}</div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400 text-center">{t.notifications.none}</p>
          ) : (
            items.map((n) => {
              const inner = (
                <div
                  className={`min-h-11 flex items-start gap-2.5 px-4 py-3 border-b border-gray-50 text-sm transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-400 ${
                    n.read ? 'text-gray-500' : 'text-gray-900 bg-blue-50/40'
                  }`}
                >
                  <div
                    className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
                      n.read ? 'bg-gray-100 text-gray-400' : 'bg-blue-100 text-blue-600'
                    }`}
                  >
                    <NotificationTypeIcon type={n.type} className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={n.read ? '' : 'font-medium'}>{renderNotification(n, t, locale)}</p>
                    <p className="text-xs text-gray-400 mt-0.5"><RelativeTime date={n.createdAt} /></p>
                  </div>
                </div>
              );
              return n.link ? (
                <Link key={n.id} href={n.link} onClick={() => setOpen(false)} className="block">
                  {inner}
                </Link>
              ) : (
                <div key={n.id}>{inner}</div>
              );
            })
          )}
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="min-h-11 flex items-center justify-center text-sm text-blue-600 hover:bg-gray-50 border-t border-gray-100"
          >
            {t.notifications.viewAll}
          </Link>
        </div>
      )}
    </div>
  );
}
