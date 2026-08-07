import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { getServerDictionary } from '@/i18n/server';
import { APP_VERSION } from '@/lib/version';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { BrandWordmark } from '@/components/BrandWordmark';
import { InstallAppButton } from '@/components/InstallAppButton';
import { GlobalSearch } from '@/components/GlobalSearch';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { PipelineStagesProvider } from '@/lib/pipelineStagesClient';
import { resolveCustomStages } from '@/lib/pipelineStages';
import { ModeSwitcher } from '@/components/ModeSwitcher';
import { MentorNav } from '@/components/MentorNav';

export default async function MentorLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  if (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN') {
    redirect('/');
  }

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { avatarUrl: true, twoFactorEnabled: true } });
  const customStages = await resolveCustomStages(session.user.orgId);

  // Auth hardening: hold in-scope roles at the 2FA setup gate until enabled.
  // Skipped while impersonating (the admin behind it is already authenticated).
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
          <p className="text-xs text-gray-500 mt-1">{t.panel.mentor}</p>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          <MentorNav />
          <InstallAppButton />
        </nav>

        {/* Admins reach this shell to work their own mentees; the switch is both
            their way back and the marker that says why the layout looks different. */}
        {session.user.role === 'ADMIN' && <ModeSwitcher />}

        <AccountMenu
          name={session.user.name}
          email={session.user.email}
          avatarUrl={me?.avatarUrl}
          fallback="M"
          avatarClassName="bg-green-100 text-green-700"
          accountHref="/account"
          locale={locale}
          version={APP_VERSION}
        />
        </aside>
      }
    >
      <PipelineStagesProvider stages={customStages}>{children}</PipelineStagesProvider>
    </ResponsiveShell>
  );
}
