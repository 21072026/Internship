'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { showBrowserNotification } from '@/lib/browserNotifications';
import { NotificationTypeIcon } from '@/components/NotificationTypeIcon';
import { renderNotification } from '@/lib/notificationText';
import { useRealtime } from '@/hooks/useRealtime';

interface Note {
  id: string;
  type: string;
  text?: string | null;
  params?: unknown;
  link?: string | null;
  read: boolean;
  createdAt: string;
}

export function NotificationBell() {
  const t = useT();
  const locale = useLocale();
  const { status } = useSession();
  const [items, setItems] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Ids we've already accounted for, so a browser notification fires once per
  // new item. null until the first poll establishes a baseline — that first
  // batch of existing unread items must NOT trigger a burst of popups.
  const seenIds = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) return;
      const d = await res.json();
      const next: Note[] = d.items ?? [];
      if (seenIds.current === null) {
        seenIds.current = new Set(next.map((n) => n.id));
      } else {
        for (const n of next) {
          if (!seenIds.current.has(n.id)) {
            seenIds.current.add(n.id);
            if (!n.read) showBrowserNotification(t.notifications.title, renderNotification(n, t, locale), n.link);
          }
        }
      }
      setItems(next);
      setUnread(d.unread ?? 0);
    } catch {
      /* ignore */
    }
  }, [t, locale]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    load();
    // Kept as a backstop under the live stream (#1464): the stream carries the
    // unread *count*, but the dropdown's rows are fetched, and a run of the
    // hourly crons can create rows with nobody publishing.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [status, load]);

  // A new row arrived, or the viewer read a thread and its message.* rows were
  // retired with it (#1464) — either way the bell's contents just changed.
  useRealtime((signal) => {
    if (signal.type === 'notification' || signal.type === 'read' || signal.type === 'tick') void load();
  });

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
      setUnread(0);
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        aria-label="Notifications"
        className="relative min-h-11 min-w-11 flex items-center justify-center text-gray-600 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 rounded-full"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
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
                    <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(n.createdAt, locale)}</p>
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
