'use client';

import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
import { useT } from '@/i18n/client';
import { useMessagesUnread } from '@/components/messagesUnreadFeed';

// Header shortcut to the message inbox, with an unread badge. Mentors/admins
// previously had to drill into a mentee's detail page to find conversations;
// this makes messaging reachable from anywhere in one click.
//
// The count is fed by the live stream (#1464) rather than a one-minute poll,
// plus one refresh per navigation for the polling fallback. The shell mounts
// two of these buttons, so the count is one shared feed (messagesUnreadFeed.ts,
// #3593): one request per navigation, not one per button.
export function MessagesButton() {
  const t = useT();
  const { status } = useSession();
  const pathname = usePathname();
  const unread = useMessagesUnread(status === 'authenticated', pathname ?? '');

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
          className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}
