'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';

/** Fired by the applications screen after a decision, so the tab's badge re-reads. */
export const APPLICATIONS_CHANGED = 'affiliate-applications-changed';

// The affiliate section's own tabs (docs/affiliate-module.md). One sidebar entry
// (/admin/affiliates), several screens under it.
export function AffiliateTabs() {
  const t = useT();
  const L = t.affiliateSettings;
  const pathname = usePathname();
  // The applications waiting for a decision (#3362), as a badge on their tab.
  // Re-read on every tab change, so a decision made on that screen shows here.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () =>
      fetch('/api/admin/affiliate/applications?count=1')
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => live && typeof b?.pending === 'number' && setPending(b.pending))
        .catch(() => {});
    void read();
    window.addEventListener(APPLICATIONS_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(APPLICATIONS_CHANGED, read);
    };
  }, [pathname]);
  const tabs = [
    { href: '/admin/affiliates', label: L.overview, exact: true },
    { href: '/admin/affiliates/partners', label: t.affiliatePartners.tab, exact: false },
    { href: '/admin/affiliates/applications', label: t.affiliateApplications.tab, exact: false },
    { href: '/admin/affiliates/payments', label: t.affiliatePayments.tab, exact: false },
    { href: '/admin/affiliates/commissions', label: t.affiliateCommissions.tab, exact: false },
    { href: '/admin/affiliates/payouts', label: t.affiliatePayouts.tab, exact: false },
    { href: '/admin/affiliates/migration', label: t.affiliateMigration.tab, exact: false },
    { href: '/admin/affiliates/settings', label: L.settings, exact: false },
  ];
  return (
    <nav className="flex gap-1 overflow-x-auto whitespace-nowrap border-b border-gray-200 dark:border-gray-800" aria-label={t.affiliateAdmin.title}>
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
            {tab.href === '/admin/affiliates/applications' && pending > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800" data-testid="affiliate-applications-pending">
                {pending}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
