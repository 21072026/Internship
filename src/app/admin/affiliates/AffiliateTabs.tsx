'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';

// The affiliate section's own tabs (docs/affiliate-module.md). One sidebar entry
// (/admin/affiliates), several screens under it.
export function AffiliateTabs() {
  const t = useT();
  const L = t.affiliateSettings;
  const pathname = usePathname();
  const tabs = [
    { href: '/admin/affiliates', label: L.overview, exact: true },
    { href: '/admin/affiliates/partners', label: t.affiliatePartners.tab, exact: false },
    { href: '/admin/affiliates/payments', label: t.affiliatePayments.tab, exact: false },
    { href: '/admin/affiliates/commissions', label: t.affiliateCommissions.tab, exact: false },
    { href: '/admin/affiliates/settings', label: L.settings, exact: false },
  ];
  return (
    <nav className="flex gap-1 border-b border-gray-200 dark:border-gray-800" aria-label={t.affiliateAdmin.title}>
      {tabs.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname?.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              active
                ? 'border-blue-600 text-blue-700 dark:text-blue-300'
                : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
