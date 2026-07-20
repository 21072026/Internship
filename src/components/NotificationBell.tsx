'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useT, useLocale } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';
import { showBrowserNotification } from '@/lib/browserNotifications';

interface Note {
  id: string;
  text: string;
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
            if (!n.read) showBrowserNotification(t.notifications.title, n.text, n.link);
          }
        }
      }
      setItems(next);
      setUnread(d.unread ?? 0);
    } catch {
      /* ignore */
    }
  }, [t.notifications.title]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [status, load]);

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
      <button onClick={toggle} aria-label="Notifications" className="relative p-2 text-gray-600 hover:text-gray-900">
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
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
                <div className={`px-4 py-3 border-b border-gray-50 text-sm ${n.read ? 'text-gray-500' : 'text-gray-900 bg-blue-50/40'}`}>
                  <p>{n.text}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{formatDateTime(n.createdAt, locale)}</p>
                </div>
              );
              return n.link ? (
                <Link key={n.id} href={n.link} onClick={() => setOpen(false)} className="block hover:bg-gray-50">
                  {inner}
                </Link>
              ) : (
                <div key={n.id}>{inner}</div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
