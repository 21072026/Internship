'use client';

import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, ChevronRight, MoreHorizontal, Search } from 'lucide-react';
import { InstallAppButton } from '@/components/InstallAppButton';
import { useT } from '@/i18n/client';
import { ADMIN_NAV_LINKS, groupNavLinks, isNavGroup, navAudienceAllows, navHubHref, visibleNavLinks, type NavGroup, type NavLink } from '@/lib/navLinks';
import { TIER_PERMISSIONS, type AdminTier } from '@/lib/authzRule';
import type { VerticalCapability } from '@/lib/verticals';
import { OutboxBadge, useOutboxPending } from '@/components/outbox/OutboxBadge';

// The route list itself lives in lib/navLinks — shared with the command
// palette's "Go to" group (#2079), so the two can never drift apart.
//
// Grouped like iOS Settings (#3752): the daily items flat on top, then one
// collapsible section per group (NAV_GROUPS order, empty groups dropped by
// groupNavLinks), each ending in a "More" row to its hub page when it has
// rarely used pages. Groups start open; a closed group is remembered per
// browser, and the group holding the current page is always open.

const COLLAPSED_KEY = 'adminNav.collapsedGroups';

function readCollapsed(): NavGroup[] {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isNavGroup) : [];
  } catch {
    return [];
  }
}

function writeCollapsed(groups: NavGroup[]) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(groups));
  } catch {
    /* storage unavailable (private mode, blocked): the state just isn't remembered */
  }
}

export function AdminNav({
  capabilities,
  superAdmin = false,
  operator = false,
  adminTier,
}: {
  capabilities?: readonly VerticalCapability[];
  superAdmin?: boolean;
  operator?: boolean;
  /** The admin's effective tier (#1579): hides the few links its tier cannot open. Cosmetic — the 403 is the control. */
  adminTier?: AdminTier | null;
}) {
  const t = useT();
  // The vertical's capability set, resolved by the layout (#2351). Undefined
  // means "not passed" — treated as the full product, so nothing is hidden by
  // capability. Super-admin-only links (#1575) need `superAdmin` either way.
  const LINKS = useMemo(
    () => {
      // No tier at all (an ADMIN never lacks one) holds nothing.
      const permissions = adminTier === undefined ? undefined : adminTier ? TIER_PERMISSIONS[adminTier] : new Set<never>();
      return capabilities
        ? visibleNavLinks(ADMIN_NAV_LINKS, capabilities, { superAdmin, operator, permissions })
        : ADMIN_NAV_LINKS.filter((l) => navAudienceAllows(l, { superAdmin, operator, permissions }));
    },
    [capabilities, superAdmin, operator, adminTier],
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

  const isActive = (l: NavLink) =>
    l.exact ? pathname === l.href : pathname === l.href || pathname.startsWith(l.href + '/');

  const { top, sections } = useMemo(() => groupNavLinks(LINKS), [LINKS]);
  const groups = t.navGroups as Record<string, string>;
  const [collapsed, setCollapsed] = useState<NavGroup[]>([]);
  // Read after mount: the server render has no storage, and reading it during
  // render would make the first client render disagree with the server's.
  useEffect(() => { setCollapsed(readCollapsed()); }, []);
  const activeGroup = useMemo(() => {
    for (const s of sections) {
      if (pathname === navHubHref(s.group) || pathname.startsWith(navHubHref(s.group) + '/')) return s.group;
      if ([...s.sidebar, ...s.hub].some(isActive)) return s.group;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, pathname]);
  const isOpen = (g: NavGroup) => g === activeGroup || !collapsed.includes(g);
  const toggle = (g: NavGroup) => {
    // The active page's group cannot be closed out from under the reader.
    if (g === activeGroup) return;
    const next = collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g];
    setCollapsed(next);
    writeCollapsed(next);
  };

  const linkRow = (l: NavLink) => {
    const Icon = l.icon;
    const active = isActive(l);
    return (
      <Link
        key={l.href}
        href={l.href}
        data-tour-id={`nav-${l.key}`}
        aria-current={active ? 'page' : undefined}
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
  };

  const searching = q.trim() !== '';

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
      {searching ? (
        // A search looks through every link, hub pages included, flat.
        items.map(linkRow)
      ) : (
        <>
          {top.map(linkRow)}
          {sections.map((section) => {
            const open = isOpen(section.group);
            const label = groups[section.group] ?? section.group;
            const hubHref = navHubHref(section.group);
            const hubActive = pathname === hubHref || pathname.startsWith(hubHref + '/');
            return (
              <div key={section.group} className="pt-3" data-testid={`nav-group-${section.group}`}>
                <button
                  type="button"
                  onClick={() => toggle(section.group)}
                  aria-expanded={open}
                  aria-controls={`nav-group-items-${section.group}`}
                  data-testid={`nav-group-toggle-${section.group}`}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <span className="flex-1">{label}</span>
                  {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                </button>
                {open && (
                  <div id={`nav-group-items-${section.group}`} className="mt-1 space-y-1">
                    {section.sidebar.map(linkRow)}
                    {section.hub.length > 0 && (
                      <Link
                        href={hubHref}
                        data-testid={`nav-hub-${section.group}`}
                        aria-current={hubActive ? 'page' : undefined}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors group ${
                          hubActive ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
                        }`}
                      >
                        <MoreHorizontal className={`h-5 w-5 ${hubActive ? 'text-blue-600' : 'text-gray-400 group-hover:text-blue-600'}`} />
                        <span className="flex-1">{t.navGroups.more}</span>
                        <ChevronRight className="h-4 w-4 text-gray-400" aria-hidden />
                      </Link>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
      {items.length === 0 && <p className="px-3 py-2 text-sm text-gray-400">{t.common.none}</p>}
      <InstallAppButton />
    </nav>
  );
}
