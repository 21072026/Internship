'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { MENTOR_NAV_LINKS, SALES_NAV_LINKS, visibleNavLinks } from '@/lib/navLinks';
import type { VerticalCapability } from '@/lib/verticals';
import { useMemo } from 'react';
import { OutboxBadge, useOutboxPending } from '@/components/outbox/OutboxBadge';
import { useMessagesUnread } from '@/components/messagesUnreadFeed';

// `set="sales"` renders the sales surface's links (#2580) with the same markup;
// the default is the mentor shell's list, unchanged.
export function MentorNav({
  capabilities,
  set = 'mentor',
}: {
  capabilities?: readonly VerticalCapability[];
  set?: 'mentor' | 'sales';
}) {
  const LINKS = useMemo(() => {
    const all = set === 'sales' ? SALES_NAV_LINKS : MENTOR_NAV_LINKS;
    return capabilities ? visibleNavLinks(all, capabilities) : all;
  }, [capabilities, set]);
  const t = useT();
  const pathname = usePathname();
  const nav = t.nav as Record<string, string>;
  // The rep's own drafts waiting for approval (#2960), on the sales surface only.
  const outboxPending = useOutboxPending(LINKS.some((l) => l.key === 'outbox'), pathname);
  // Unread messages on the sales menu's inbox row: the same shared count the
  // header button reads, so the two never disagree.
  const messagesUnread = useMessagesUnread(set === 'sales' && LINKS.some((l) => l.key === 'messages'), pathname);

  // The route list lives in lib/navLinks — shared with the command palette's
  // "Go to" group (#2079), so the two can never drift apart.
  const isActive = (link: (typeof LINKS)[number]) =>
    link.exact ? pathname === link.href : pathname.startsWith(link.href);

  return (
    <>
      {LINKS.map((link) => {
        const Icon = link.icon;
        const active = isActive(link);
        return (
          <Link
            key={link.href}
            href={link.href}
            data-tour-id={`nav-${link.key}`}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group ${
              active
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
            }`}
          >
            <Icon className={`h-5 w-5 ${active ? 'text-blue-600' : 'text-gray-400 group-hover:text-blue-600'}`} />
            <span className="flex-1">{nav[link.key] ?? link.key}</span>
            {link.key === 'outbox' && outboxPending > 0 && <OutboxBadge count={outboxPending} />}
            {set === 'sales' && link.key === 'messages' && messagesUnread > 0 && (
              <span
                className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-red-600 text-white text-[11px] font-bold flex items-center justify-center"
                data-testid="sales-nav-messages-unread"
              >
                {messagesUnread > 9 ? '9+' : messagesUnread}
              </span>
            )}
          </Link>
        );
      })}
    </>
  );
}
