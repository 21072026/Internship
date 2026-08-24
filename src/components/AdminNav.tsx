'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Columns3, Building2, Users, UserCheck, UserCog, Mail, ScrollText,
  BarChart3, FolderGit2, Layers, Radio, Megaphone, FileText, CalendarDays, ClipboardCheck, Settings, Webhook, Search, ListChecks,
  ShieldCheck, Activity, LifeBuoy, Network, Video, ClipboardList, GraduationCap, BriefcaseBusiness, GitMerge, Quote, FileSignature, Tag as TagIcon, UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { InstallAppButton } from '@/components/InstallAppButton';
import { useT } from '@/i18n/client';

// key matches t.nav.<key>; exact marks the dashboard root so it isn't always active.
const LINKS: { href: string; icon: LucideIcon; key: string; exact?: boolean }[] = [
  { href: '/admin', icon: LayoutDashboard, key: 'dashboard', exact: true },
  { href: '/admin/board', icon: Columns3, key: 'board' },
  { href: '/admin/companies', icon: Building2, key: 'companies' },
  { href: '/admin/requisitions', icon: BriefcaseBusiness, key: 'requisitions' },
  { href: '/admin/interview-requests', icon: CalendarDays, key: 'interviewRequests' },
  { href: '/interviews', icon: ClipboardCheck, key: 'interviewPanels' },
  { href: '/admin/candidates', icon: Users, key: 'candidates' },
  { href: '/admin/duplicates', icon: GitMerge, key: 'duplicates' },
  { href: '/admin/mentors', icon: UserCheck, key: 'mentors' },
  { href: '/admin/mentorship', icon: Users, key: 'mentorships' },
  { href: '/admin/mentor-applications', icon: GraduationCap, key: 'mentorApplications' },
  { href: '/admin/company-inquiries', icon: Building2, key: 'companyInquiries' },
  { href: '/admin/projects', icon: FolderGit2, key: 'projects' },
  { href: '/admin/goal-templates', icon: ListChecks, key: 'goalTemplates' },
  { href: '/todos', icon: ClipboardList, key: 'todos' },
  { href: '/admin/cohorts', icon: Layers, key: 'cohorts' },
  { href: '/admin/tags', icon: TagIcon, key: 'tags' },
  { href: '/admin/sources', icon: Radio, key: 'sources' },
  { href: '/admin/users', icon: UserCog, key: 'users' },
  { href: '/admin/meetings', icon: Video, key: 'meetings' },
  { href: '/admin/calendar', icon: CalendarDays, key: 'calendar' },
  { href: '/admin/announcements', icon: Megaphone, key: 'announcements' },
  { href: '/admin/testimonials', icon: Quote, key: 'testimonials' },
  { href: '/admin/email', icon: Mail, key: 'email' },
  { href: '/admin/documents', icon: FileText, key: 'documents' },
  { href: '/admin/support', icon: LifeBuoy, key: 'support' },
  { href: '/admin/activity', icon: ScrollText, key: 'activity' },
  { href: '/admin/mentee-activity', icon: Activity, key: 'menteeActivity' },
  { href: '/admin/analytics', icon: BarChart3, key: 'analytics' },
  { href: '/admin/integrations', icon: Webhook, key: 'integrations' },
  { href: '/admin/retention', icon: ShieldCheck, key: 'retention' },
  { href: '/admin/re-engagement', icon: UserPlus, key: 'reEngagement' },
  { href: '/admin/contributor-terms', icon: FileSignature, key: 'contributorTerms' },
  { href: '/admin/organizations', icon: Network, key: 'organizations' },
  { href: '/admin/settings', icon: Settings, key: 'settings' },
  { href: '/admin/invite', icon: Mail, key: 'invite' },
];

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
