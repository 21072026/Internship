import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { LayoutDashboard, Sparkles } from 'lucide-react';
import { getServerDictionary } from '@/i18n/server';
import { APP_VERSION } from '@/lib/version';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { BrandWordmark } from '@/components/BrandWordmark';
import { InstallAppButton } from '@/components/InstallAppButton';
import { prisma } from '@/lib/prisma';
import { hasFeature } from '@/lib/entitlements';

export default async function CompanyLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) redirect('/auth/signin');
  if (session.user.role !== 'COMPANY' && session.user.role !== 'ADMIN') redirect('/');

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { avatarUrl: true } });
  // Show the premium talent-pool link only when the company is entitled (admins
  // always see it for support).
  const showTalentPool = session.user.role === 'ADMIN' || (await hasFeature(session.user.companyId, 'TALENT_POOL_SEARCH'));

  return (
    <ResponsiveShell
      brand={<BrandWordmark />}
      sidebar={
        <aside className="w-64 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <BrandWordmark />
              <BetaBadge />
            </div>
            <p className="text-xs text-gray-500 mt-1">{t.panel.company}</p>
          </div>

          <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
            <Link
              href="/company"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
            >
              <LayoutDashboard className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
              {t.nav.dashboard}
            </Link>
            {showTalentPool && (
              <Link
                href="/company/talent-pool"
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors group"
              >
                <Sparkles className="h-5 w-5 text-gray-400 group-hover:text-blue-600" />
                {t.talentPool.navLink}
              </Link>
            )}
            <InstallAppButton />
        </nav>

          <AccountMenu
            name={session.user.name}
            email={session.user.email}
            avatarUrl={me?.avatarUrl}
            fallback="C"
            avatarClassName="bg-indigo-100 text-indigo-700"
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
