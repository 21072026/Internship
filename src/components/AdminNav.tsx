'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import { InstallAppButton } from '@/components/InstallAppButton';
import { useT } from '@/i18n/client';
import { ADMIN_NAV_LINKS } from '@/lib/navLinks';

// The route list itself lives in lib/navLinks — shared with the command
// palette's "Go to" group (#2079), so the two can never drift apart.
const LINKS = ADMIN_NAV_LINKS;

export function AdminNav() {
  const t = useT();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const nav = t.nav as Record<string, string>;
  const [pendingApplications, setPendingApplications] = useState(0);

  // Mentor applications are the one queue an admin is expected to drain, so the
  // nav carries its pending count. Refetched on navigation rather than on a
  // timer: every decision (approve/reject/review) leaves the detail page, so
  // route changes already cover the moments the count can actually change.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/mentor-applications?status=PENDING')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setPendingApplications(d?.total ?? 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pathname]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return LINKS;
    return LINKS.filter((l) => (nav[l.key] ?? l.key).toLowerCase().includes(needle));
  }, [q, nav]);

  const isActive = (l: (typeof LINKS)[number]) =>
    l.exact ? pathname === l.href : pathname === l.href || pathname.startsWith(l.href + '/');

  return (
    <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
      <div className="relative mb-2">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.nav.filterPlaceholder}
          aria-label={t.nav.filterPlaceholder}
          className="w-full rounded-lg border border-gray-200 pl-8 pr-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
        />
      </div>
      {items.map((l) => {
        const Icon = l.icon;
        const active = isActive(l);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group ${
              active ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
            }`}
          >
            <Icon className={`h-5 w-5 ${active ? 'text-blue-600' : 'text-gray-400 group-hover:text-blue-600'}`} />
            <span className="flex-1">{nav[l.key] ?? l.key}</span>
            {l.key === 'mentorApplications' && pendingApplications > 0 && (
              <span
                data-testid="mentor-applications-badge"
                title={t.mentorApplicationsAdmin.pendingBadge.replace('{count}', String(pendingApplications))}
                aria-label={t.mentorApplicationsAdmin.pendingBadge.replace('{count}', String(pendingApplications))}
                className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center dark:!bg-red-500 dark:!text-white"
              >
                {pendingApplications > 9 ? '9+' : pendingApplications}
              </span>
            )}
          </Link>
        );
      })}
      {items.length === 0 && <p className="px-3 py-2 text-sm text-gray-400">{t.common.none}</p>}
      <InstallAppButton />
    </nav>
  );
}
