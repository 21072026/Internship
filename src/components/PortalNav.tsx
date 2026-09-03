'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';
import { PORTAL_NAV_LINKS } from '@/lib/navLinks';

// Mentee portal sidebar navigation with active-route highlighting (mirrors the
// admin/mentor navs). Client component so it can read the current pathname.
// The route list lives in lib/navLinks — shared with the command palette's
// "Go to" group (#2079), so the two can never drift apart.
export function PortalNav() {
  const t = useT();
  const pathname = usePathname();
  const nav = t.nav as Record<string, string>;

  const isActive = (link: (typeof PORTAL_NAV_LINKS)[number]) =>
    link.exact ? pathname === link.href : pathname.startsWith(link.href);

  return (
    <>
      {PORTAL_NAV_LINKS.map((link) => {
        const Icon = link.icon;
        const active = isActive(link);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group ${
              active
                ? 'bg-blue-50 text-blue-700 font-medium'
                : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
            }`}
          >
            <Icon className={`h-5 w-5 ${active ? 'text-blue-600' : 'text-gray-400 group-hover:text-blue-600'}`} />
            {nav[link.key] ?? link.key}
          </Link>
        );
      })}
    </>
  );
}
