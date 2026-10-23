import { getServerSession } from 'next-auth';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { AFFILIATE_NAV_LINKS } from '@/lib/navLinks';
import { authOptions } from '@/lib/auth';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { getServerDictionary } from '@/i18n/server';
import { APP_VERSION } from '@/lib/version';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { BrandWordmark } from '@/components/BrandWordmark';
import { InstallAppButton } from '@/components/InstallAppButton';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { shellCapabilities } from '@/lib/shellCapabilities';

// The partner portal shell (docs/affiliate-module.md). AFFILIATE only, and only in
// a vertical that carries the affiliate module — anywhere else the URL is 404.
export default async function AffiliateLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'AFFILIATE') redirect('/');
  if (!(await shellCapabilities(session.user.orgId)).includes('affiliate')) notFound();

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
            <p className="text-xs text-gray-500 mt-1">{t.panel.affiliate}</p>
          </div>

          <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
            {AFFILIATE_NAV_LINKS.map(({ href, icon: Icon, key }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
              >
                <Icon className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
                {t.nav[key as keyof typeof t.nav]}
              </Link>
            ))}
            <InstallAppButton />
          </nav>

          <AccountMenu
            name={session.user.name}
            email={session.user.email}
            avatarUrl={me?.avatarUrl}
            fallback="P"
            avatarClassName="bg-blue-100 text-blue-700"
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
