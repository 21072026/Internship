'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
import { useT } from '@/i18n/client';

// Header shortcut to the message inbox, with an unread badge. Mentors/admins
// previously had to drill into a mentee's detail page to find conversations;
// this makes messaging reachable from anywhere in one click.
export function MessagesButton() {
  const t = useT();
  const { status } = useSession();
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/messages/unread');
      if (!res.ok) return;
      const d = await res.json();
      setUnread(d.count ?? 0);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return;
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [status, load]);

  // Re-check when navigating (e.g. after opening a thread and reading it).
  useEffect(() => {
    if (status === 'authenticated') load();
  }, [pathname, status, load]);

  if (status !== 'authenticated') return null;

  return (
    <Link
      href="/messages"
      aria-label={t.messages.title}
      title={t.messages.title}
      className="relative p-2 text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
    >
      <MessageSquare className="h-5 w-5" />
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}
