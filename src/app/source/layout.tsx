import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { LayoutDashboard, KeyRound } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { APP_VERSION } from '@/lib/version';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { BrandWordmark } from '@/components/BrandWordmark';
import { InstallAppButton } from '@/components/InstallAppButton';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { I18nScope } from '@/i18n/scope';

async function SourceLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'SOURCE' && session.user.role !== 'ADMIN') redirect('/');
  // The referral-partner portal is the `sourcing` module; a vertical without it
  // (MARKETING) has no portal, so the URL answers 404 like a gated admin page.
  if (!(await shellCapabilities(session.user.orgId)).includes('sourcing')) notFound();

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { avatarUrl: true, twoFactorEnabled: true } });
  // The same 2FA hold as every other authenticated shell (#1644); see the
  // company layout for why, and why impersonation is excluded.
  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role, await settingsOrgOf(session)))) {
    redirect('/security-setup');
  }

  return (
    <ResponsiveShell
      brand={<BrandWordmark oneLine />}
      sidebar={
        <aside className="w-64 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <BrandWordmark />
              <BetaBadge />
            </div>
            <p className="text-xs text-gray-500 mt-1">{t.panel.source}</p>
          </div>

          <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
            <Link
              href="/source"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
            >
              <LayoutDashboard className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
              {t.nav.dashboard}
            </Link>
            <Link
              href="/source/integrations"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
            >
              <KeyRound className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
              {t.sourceIntegrations.navLink}
            </Link>
            <InstallAppButton />
          </nav>

          <AccountMenu
            name={session.user.name}
            email={session.user.email}
            avatarUrl={me?.avatarUrl}
            fallback="S"
            avatarClassName="bg-green-100 text-green-700"
            accountHref="/account"
            locale={locale}
            version={APP_VERSION}
          />
        </aside>
      }
    >
      {children}
    </ResponsiveShell>
  );
}

// The segment's dictionary namespaces wrap the WHOLE layout, its own chrome
// included (#2987, src/i18n/scope.tsx).
export default function ScopedSourceLayout({ children }: { children: React.ReactNode }) {
  return (
    <I18nScope scope="source">
      <SourceLayout>{children}</SourceLayout>
    </I18nScope>
  );
}
