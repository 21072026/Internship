'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Columns3, Building2, Users, UserCheck, UserCog, Mail, ScrollText,
  BarChart3, FolderGit2, Layers, Radio, Megaphone, FileText, CalendarDays, Settings, Webhook, Search,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { InstallAppButton } from '@/components/InstallAppButton';
import { useT } from '@/i18n/client';

// key matches t.nav.<key>; exact marks the dashboard root so it isn't always active.
const LINKS: { href: string; icon: LucideIcon; key: string; exact?: boolean }[] = [
  { href: '/admin', icon: LayoutDashboard, key: 'dashboard', exact: true },
  { href: '/admin/board', icon: Columns3, key: 'board' },
  { href: '/admin/companies', icon: Building2, key: 'companies' },
  { href: '/admin/candidates', icon: Users, key: 'candidates' },
  { href: '/admin/mentors', icon: UserCheck, key: 'mentors' },
  { href: '/admin/mentorship', icon: Users, key: 'mentorships' },
  { href: '/admin/projects', icon: FolderGit2, key: 'projects' },
  { href: '/admin/cohorts', icon: Layers, key: 'cohorts' },
  { href: '/admin/sources', icon: Radio, key: 'sources' },
  { href: '/admin/users', icon: UserCog, key: 'users' },
  { href: '/admin/calendar', icon: CalendarDays, key: 'calendar' },
  { href: '/admin/announcements', icon: Megaphone, key: 'announcements' },
  { href: '/admin/documents', icon: FileText, key: 'documents' },
  { href: '/admin/activity', icon: ScrollText, key: 'activity' },
  { href: '/admin/analytics', icon: BarChart3, key: 'analytics' },
  { href: '/admin/integrations', icon: Webhook, key: 'integrations' },
  { href: '/admin/retention', icon: ShieldCheck, key: 'retention' },
  { href: '/admin/settings', icon: Settings, key: 'settings' },
  { href: '/admin/invite', icon: Mail, key: 'invite' },
];

export function AdminNav() {
  const t = useT();
  const pathname = usePathname();
  const [q, setQ] = useState('');
  const nav = t.nav as Record<string, string>;

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
            {nav[l.key] ?? l.key}
          </Link>
        );
      })}
      {items.length === 0 && <p className="px-3 py-2 text-sm text-gray-400">{t.common.none}</p>}
      <InstallAppButton />
    </nav>
  );
}
