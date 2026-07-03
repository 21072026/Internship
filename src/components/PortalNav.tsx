'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, User, BookOpen, MessageSquare, Lock } from 'lucide-react';
import { useT } from '@/i18n/client';

// Mentee portal sidebar navigation with active-route highlighting (mirrors the
// admin/mentor navs). Client component so it can read the current pathname.
export function PortalNav() {
  const t = useT();
  const pathname = usePathname();

  const links = [
    { href: '/portal', label: t.nav.dashboard, Icon: LayoutDashboard },
    { href: '/portal/profile', label: t.nav.myProfile, Icon: User },
    { href: '/portal/messages', label: t.nav.messages, Icon: MessageSquare },
    { href: '/portal/interactions', label: t.nav.interactionLogs, Icon: BookOpen },
    { href: '/portal/notes', label: t.portal.notes.title, Icon: Lock },
  ];

  const isActive = (href: string) =>
    href === '/portal' ? pathname === '/portal' : pathname.startsWith(href);

  return (
    <>
      {links.map(({ href, label, Icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group ${
              active
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
            }`}
          >
            <Icon className={`h-5 w-5 ${active ? 'text-blue-600' : 'text-gray-400 group-hover:text-blue-600'}`} />
            {label}
          </Link>
        );
      })}
    </>
  );
}
