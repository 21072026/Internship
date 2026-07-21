import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { getServerDictionary } from '@/i18n/server';
import { APP_VERSION } from '@/lib/version';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { BrandWordmark } from '@/components/BrandWordmark';
import { AdminNav } from '@/components/AdminNav';
import { GlobalSearch } from '@/components/GlobalSearch';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  if (session.user.role !== 'ADMIN') {
    redirect('/');
  }

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { avatarUrl: true, twoFactorEnabled: true } });

  // Auth hardening: when the org requires 2FA for this role, hold the user at a
  // setup gate until they enable it. Skipped while impersonating (the admin is
  // already authenticated; the impersonated identity's 2FA state is irrelevant).
  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role))) {
    redirect('/security-setup');
  }

  return (
    <ResponsiveShell
      brand={<BrandWordmark />}
      headerExtra={<GlobalSearch />}
      sidebar={
        <aside className="w-64 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <BrandWordmark />
            <BetaBadge />
          </div>
          <p className="text-xs text-gray-500 mt-1">{t.panel.admin}</p>
        </div>

        <AdminNav />

        <AccountMenu
          name={session.user.name}
          email={session.user.email}
          avatarUrl={me?.avatarUrl}
          fallback="A"
          avatarClassName="bg-blue-100 text-blue-700"
          accountHref="/admin/account"
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
