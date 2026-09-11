import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { getServerDictionary } from '@/i18n/server';
import { APP_VERSION } from '@/lib/version';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { CommandPalette } from '@/components/CommandPalette';
import { BrandWordmark } from '@/components/BrandWordmark';
import { AdminNav } from '@/components/AdminNav';
import { MentorNav } from '@/components/MentorNav';
import { PortalNav } from '@/components/PortalNav';
import { ModeSwitcher } from '@/components/ModeSwitcher';
import { availableModes } from '@/lib/dualRole';
import { GlobalSearch } from '@/components/GlobalSearch';
import { InstallAppButton } from '@/components/InstallAppButton';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { PipelineStagesProvider } from '@/lib/pipelineStagesClient';
import { resolveCustomStages } from '@/lib/pipelineStages';
import { EvaluationCriteriaProvider } from '@/lib/evaluationCriteriaClient';
import { resolveCustomCriteria } from '@/lib/evaluationTemplates';

export async function RoleShell({
  children,
  forcedRole,
}: {
  children: React.ReactNode;
  forcedRole?: 'ADMIN' | 'MENTOR' | 'MENTEE';
}) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  const role = forcedRole ?? (session.user.role as 'ADMIN' | 'MENTOR' | 'MENTEE');

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { avatarUrl: true, twoFactorEnabled: true },
  });

  const customStages = await resolveCustomStages(session.user.orgId);
  const customCriteria = await resolveCustomCriteria(session.user.orgId);
  const modes = await availableModes(session.user);

  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role))) {
    redirect('/security-setup');
  }

  const isAdmin = role === 'ADMIN';
  const isMentor = role === 'MENTOR';

  return (
    <>
      <CommandPalette role={isAdmin ? 'ADMIN' : isMentor ? 'MENTOR' : 'MENTEE'} />
      <ResponsiveShell
        brand={<BrandWordmark oneLine />}
        headerExtra={isAdmin || isMentor ? <GlobalSearch /> : undefined}
        sidebar={
          <aside className="w-64 h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
            <div className="p-6 border-b border-gray-200 dark:border-gray-800">
              <div className="flex items-center gap-2">
                <BrandWordmark />
                <BetaBadge />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {isAdmin ? t.panel.admin : isMentor ? t.panel.mentor : t.panel.mentee}
              </p>
            </div>

            {isAdmin ? (
              <AdminNav />
            ) : isMentor ? (
              <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
                <MentorNav />
                <InstallAppButton />
              </nav>
            ) : (
              <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
                <PortalNav />
                <InstallAppButton />
              </nav>
            )}

            <ModeSwitcher modes={modes} />

            <AccountMenu
              name={session.user.name}
              email={session.user.email}
              avatarUrl={me?.avatarUrl}
              fallback={isAdmin ? 'A' : 'M'}
              avatarClassName={
                isAdmin
                  ? 'bg-blue-100 text-blue-700'
                  : isMentor
                  ? 'bg-green-100 text-green-700'
                  : 'bg-purple-100 text-purple-700'
              }
              accountHref={isAdmin ? '/admin/account' : '/account'}
              locale={locale}
              version={APP_VERSION}
            />
          </aside>
        }
      >
        <PipelineStagesProvider stages={customStages}>
          <EvaluationCriteriaProvider criteria={customCriteria}>{children}</EvaluationCriteriaProvider>
        </PipelineStagesProvider>
      </ResponsiveShell>
    </>
  );
}
