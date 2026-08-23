'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';

// Section tabs for the mentee portal (#916): the dashboard keeps a short
// summary and the heavier panels live on real sub-routes, so deep links and
// the back button behave. Markup mirrors the admin segmented-control pattern
// (role=tablist/tab + aria-selected, e.g. admin/candidates).
const TABS = [
  { href: '/portal', key: 'summary' },
  { href: '/portal/journey', key: 'journey' },
  { href: '/portal/goals', key: 'goals' },
  { href: '/portal/requests', key: 'requests' },
] as const;

export function PortalTabs() {
  const t = useT();
  const pathname = usePathname();
  return (
    <div role="tablist" aria-label={t.portal.dashSubtitle} className="mb-6 flex flex-wrap gap-1 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-1">
      {TABS.map(({ href, key }) => {
        const active = href === '/portal' ? pathname === '/portal' : pathname.startsWith(href);
        return (
          <Link
            key={key}
            href={href}
            role="tab"
            aria-selected={active}
            data-testid={`portal-tab-${key}`}
            className={`min-h-11 flex items-center rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-medium'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
            }`}
          >
            {t.portal.tabs[key]}
          </Link>
        );
      })}
    </div>
  );
}
