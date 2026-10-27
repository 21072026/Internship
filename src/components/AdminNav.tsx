'use client';

import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search } from 'lucide-react';
import { InstallAppButton } from '@/components/InstallAppButton';
import { useT } from '@/i18n/client';
import { ADMIN_NAV_LINKS, visibleNavLinks } from '@/lib/navLinks';
import type { VerticalCapability } from '@/lib/verticals';
import { OutboxBadge, useOutboxPending } from '@/components/outbox/OutboxBadge';

// The route list itself lives in lib/navLinks — shared with the command
// palette's "Go to" group (#2079), so the two can never drift apart.

export function AdminNav({ capabilities, superAdmin = false }: { capabilities?: readonly VerticalCapability[]; superAdmin?: boolean }) {
  const t = useT();
  // The vertical's capability set, resolved by the layout (#2351). Undefined
  // means "not passed" — treated as the full product, so nothing is hidden by
  // capability. Super-admin-only links (#1575) need `superAdmin` either way.
  const LINKS = useMemo(
    () =>
      capabilities
        ? visibleNavLinks(ADMIN_NAV_LINKS, capabilities, { superAdmin })
        : ADMIN_NAV_LINKS.filter((l) => !l.superAdminOnly || superAdmin),
    [capabilities, superAdmin],
  );
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const nav = t.nav as Record<string, string>;
  const [pendingApplications, setPendingApplications] = useState(0);
  const [outstandingOffers, setOutstandingOffers] = useState(0);
  const [hiringActionable, setHiringActionable] = useState(0);

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

  // Sent-but-undecided offers are the second such queue (#1873). pageSize=1
  // because only the count is wanted — the total comes from the server's
  // count(), so one row is enough to carry it.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/offers?status=SENT&pageSize=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setOutstandingOffers(d?.total ?? 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pathname]);

  // The hiring desk (#1874): interview requests awaiting a decision plus offers
  // expiring this week — the two queues there that a person must act on.
  // Asked only where the desk exists (the link survived the vertical filter).
  const hasHiring = LINKS.some((l) => l.key === 'hiring');
  useEffect(() => {
    if (!hasHiring) return;
    let cancelled = false;
    fetch('/api/admin/hiring/queues?summary=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled) setHiringActionable(d?.actionable ?? 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [pathname, hasHiring]);

  // Mail held for approval (#2960) — the third queue an admin drains. Asked
  // only where the outbox exists (the link survived the vertical filter).
  const outboxPending = useOutboxPending(LINKS.some((l) => l.key === 'outbox'), pathname);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return LINKS;
    return LINKS.filter((l) => (nav[l.key] ?? l.key).toLowerCase().includes(needle));
  }, [q, nav, LINKS]);
  // WCAG 4.1.3 (#2864): the list is rewritten in place without moving focus,
  // so the new result count is spoken (debounced) while a filter is active.
  useFilterAnnouncement(q.trim() !== '' ? resultCountMessage(t.a11y, items.length) : null);

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
                className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center dark:!bg-red-600 dark:!text-white"
              >
                {pendingApplications > 9 ? '9+' : pendingApplications}
              </span>
            )}
            {l.key === 'outbox' && outboxPending > 0 && <OutboxBadge count={outboxPending} />}
            {l.key === 'hiring' && hiringActionable > 0 && (
              <span
                data-testid="admin-hiring-badge"
                title={t.hiringDesk.actionableBadge.replace('{count}', String(hiringActionable))}
                aria-label={t.hiringDesk.actionableBadge.replace('{count}', String(hiringActionable))}
                className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center dark:!bg-red-600 dark:!text-white"
              >
                {hiringActionable > 9 ? '9+' : hiringActionable}
              </span>
            )}
            {l.key === 'offers' && outstandingOffers > 0 && (
              <span
                data-testid="admin-offers-badge"
                title={t.offersAdmin.outstandingBadge.replace('{count}', String(outstandingOffers))}
                aria-label={t.offersAdmin.outstandingBadge.replace('{count}', String(outstandingOffers))}
                className="min-w-[18px] h-[18px] px-1 rounded-full bg-amber-700 text-white text-[10px] font-bold flex items-center justify-center dark:!bg-amber-700 dark:!text-white"
              >
                {outstandingOffers > 9 ? '9+' : outstandingOffers}
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
