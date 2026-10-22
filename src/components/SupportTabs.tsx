'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useT } from '@/i18n/client';

// The two halves of /admin/support (#3130): the conversation queue and the
// in-app bug reports. Plain links, so each tab is its own URL.
export function SupportTabs() {
  const t = useT();
  const path = usePathname() ?? '';
  const onReports = path.startsWith('/admin/support/reports');
  const tab = (href: string, label: string, active: boolean) => (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`border-b-2 px-3 py-2 text-sm font-medium ${
        active
          ? 'border-blue-600 text-blue-700 dark:text-blue-400'
          : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="mb-5 flex gap-2 border-b border-gray-200 dark:border-gray-800" data-testid="support-tabs">
      {tab('/admin/support', t.adminReports.tabTickets, !onReports)}
      {tab('/admin/support/reports', t.adminReports.tabReports, onReports)}
    </nav>
  );
}
