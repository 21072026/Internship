'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useRealtime } from '@/hooks/useRealtime';

// Header shortcut to the message inbox, with an unread badge. Mentors/admins
// previously had to drill into a mentee's detail page to find conversations;
// this makes messaging reachable from anywhere in one click.
//
// The count is fed by the live stream (#1464) rather than a one-minute poll:
// both directions were a minute late, so a message that arrived showed up late
// and — worse — a message that had just been read kept its badge for the rest of
// the minute. It still keeps a fetch of its own for the same-navigation refresh
// below, which no signal can stand in for.
export function MessagesButton() {
  const t = useT();
  const { status } = useSession();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/messages/unread', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();
      setUnread(d.count ?? 0);
    } catch {
      /* ignore */
    }
  }, []);

  useRealtime((signal) => {
    if (signal.type === 'ready' || signal.type === 'unread') setUnread(signal.counts.messages);
  });

  // Re-check when navigating (e.g. after opening a thread and reading it). The
  // stream reports the same drop, but only this covers the polling fallback,
  // where the badge would otherwise hold a stale number until the next tick.
  useEffect(() => {
    if (status === 'authenticated') load();
  }, [pathname, status, load]);

  if (status !== 'authenticated') return null;

  return (
    <Link
      href="/messages"
      aria-label={t.messages.title}
      title={t.messages.title}
      className="relative inline-flex min-h-11 min-w-11 items-center justify-center text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
    >
      <MessageSquare className="h-5 w-5" />
      {unread > 0 && (
        <span
          data-testid="messages-unread-badge"
          className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}
