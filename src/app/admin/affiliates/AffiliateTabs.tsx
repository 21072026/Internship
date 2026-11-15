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
  type Tab = { href: string; label: string; exact?: boolean };
  type Item = Tab | { group: string; label: string; tabs: Tab[] };
  // Two money flows, two groups (#3538): what customers pay the product, and what
  // the partners earn and are paid. URLs are unchanged; a group opens its first screen.
  const items: Item[] = [
    { href: '/admin/affiliates', label: L.overview, exact: true },
    {
      group: 'customers',
      label: t.affiliateAdmin.groupCustomers,
      tabs: [
        { href: '/admin/affiliates/customers', label: t.affiliateCustomers.tab },
        { href: '/admin/affiliates/payments', label: t.affiliatePayments.tab },
      ],
    },
    {
      group: 'partners',
      label: t.affiliateAdmin.groupPartners,
      tabs: [
        { href: '/admin/affiliates/partners', label: t.affiliatePartners.tab },
        { href: '/admin/affiliates/applications', label: t.affiliateApplications.tab },
        { href: '/admin/affiliates/funnel', label: t.affiliateFunnel.tab },
        { href: '/admin/affiliates/commissions', label: t.affiliateCommissions.tab },
        { href: '/admin/affiliates/payouts', label: t.affiliatePayouts.tab },
      ],
    },
    { href: '/admin/affiliates/migration', label: t.affiliateMigration.tab },
    { href: '/admin/affiliates/settings', label: L.settings },
  ];
  const isActive = (tab: Tab) => (tab.exact ? pathname === tab.href : !!pathname?.startsWith(tab.href));
  const openGroup = items.find((i): i is Extract<Item, { group: string }> => 'group' in i && i.tabs.some(isActive));
  const tabClass = (active: boolean) =>
    `px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
      active
        ? 'border-blue-600 text-blue-700 dark:text-blue-300'
        : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
    }`;
  // The applications badge sits where it can be seen: on the open sub-tab, or on
  // the Partners group while that group is closed — never twice.
  const badge = (
    <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800" data-testid="affiliate-applications-pending">
      {pending}
    </span>
  );
  return (
    <div>
      <nav className="flex gap-1 overflow-x-auto whitespace-nowrap border-b border-gray-200 dark:border-gray-800" aria-label={t.affiliateAdmin.title}>
        {items.map((item) => {
          if ('group' in item) {
            const open = item === openGroup;
            return (
              <Link
                key={item.group}
                href={item.tabs[0].href}
                // The group is the current section, not the current page (the sub-tab is).
                aria-current={open ? 'true' : undefined}
                className={tabClass(open)}
                data-testid={`affiliate-group-${item.group}`}
              >
                {item.label}
                {item.group === 'partners' && !open && pending > 0 && badge}
              </Link>
            );
          }
          const active = isActive(item);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} className={tabClass(active)}>
              {item.label}
            </Link>
          );
        })}
      </nav>
      {openGroup && (
        <nav
          className="flex gap-1 overflow-x-auto whitespace-nowrap border-b border-gray-200 dark:border-gray-800"
          aria-label={openGroup.label}
          data-testid="affiliate-subtabs"
        >
          {openGroup.tabs.map((tab) => {
            const active = isActive(tab);
            return (
              <Link key={tab.href} href={tab.href} aria-current={active ? 'page' : undefined} className={tabClass(active)}>
                {tab.label}
                {tab.href === '/admin/affiliates/applications' && pending > 0 && badge}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
