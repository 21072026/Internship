import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { ChevronRight } from 'lucide-react';
import { authOptions } from '@/lib/auth';
import { getServerDictionary } from '@/i18n/server';
import { ADMIN_NAV_LINKS, groupNavLinks, isNavGroup, visibleNavLinks } from '@/lib/navLinks';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { isSuperAdmin } from '@/lib/superAdmin';
import { resolveQueueScope } from '@/lib/mailQueueAdmin';
import { adminTierFor, TIER_PERMISSIONS } from '@/lib/authzRule';

// /admin/hub/<group> (#3752): the iOS-Settings-style page behind a sidebar
// group's "More" row. It lists the group's rarely used pages (`hub: true` in
// src/lib/navLinks.ts) — rendered from the same list and through the same
// filters as the sidebar, so it can never offer a page the sidebar would hide
// from this admin. Presentation only: every destination guards itself.
// src/app/admin/layout.tsx has already turned away a non-ADMIN.
export default async function AdminHubPage({ params }: { params: Promise<{ group: string }> }) {
  const { group } = await params;
  if (!isNavGroup(group)) notFound();
  const session = await getServerSession(authOptions);
  if (!session) notFound();

  const [capabilities, superAdmin, { t }] = await Promise.all([
    shellCapabilities(session.user.orgId),
    isSuperAdmin(session),
    getServerDictionary(),
  ]);
  const operator = superAdmin || (await resolveQueueScope(session)) !== null;
  const tier = adminTierFor(session.user.role, session.user.adminLevel);
  const permissions = tier ? TIER_PERMISSIONS[tier] : new Set<never>();
  const visible = visibleNavLinks(ADMIN_NAV_LINKS, capabilities, { superAdmin, operator, permissions });
  const section = groupNavLinks(visible).sections.find((s) => s.group === group);
  const rows = section?.hub ?? [];

  const nav = t.nav as Record<string, string>;
  const descriptions = { ...(t.navHub as Record<string, string>), ...(t.navHubInternship as Record<string, string>) };
  const title = (t.navGroups as Record<string, string>)[group] ?? group;

  return (
    <div className="max-w-2xl" data-testid={`nav-hub-page-${group}`}>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
      <p className="mt-1 mb-6 text-sm text-gray-500 dark:text-gray-400">{t.navGroups.hubLead}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="nav-hub-empty">{t.navGroups.hubEmpty}</p>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
          {rows.map((l) => {
            const Icon = l.icon;
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  data-testid={`nav-hub-row-${l.key}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700" aria-hidden>
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-gray-900 dark:text-gray-100">{nav[l.key] ?? l.key}</span>
                    {descriptions[l.key] && (
                      <span className="block text-sm text-gray-500 dark:text-gray-400">{descriptions[l.key]}</span>
                    )}
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-gray-400" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
