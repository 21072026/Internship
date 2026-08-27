import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { getServerDictionary } from '@/i18n/server';
import { PortalNav } from '@/components/PortalNav';
import { APP_VERSION } from '@/lib/version';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { BrandWordmark } from '@/components/BrandWordmark';
import { InstallAppButton } from '@/components/InstallAppButton';
import { prisma } from '@/lib/prisma';
import { PipelineStagesProvider } from '@/lib/pipelineStagesClient';
import { resolveCustomStages } from '@/lib/pipelineStages';
import { EvaluationCriteriaProvider } from '@/lib/evaluationCriteriaClient';
import { resolveCustomCriteria } from '@/lib/evaluationTemplates';
import { ModeSwitcher } from '@/components/ModeSwitcher';
import { availableModes, canUsePortal } from '@/lib/dualRole';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { PortalTabs } from '@/components/PortalTabs';

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  if (session.user.role === 'COMPANY') {
    redirect('/company');
  }

  // An admin or mentor lands here only if they are *themselves* being mentored
  // (#1141) — helping someone doesn't stop you needing help. Without a
  // mentorship of their own the portal has nothing to show them, so they go back
  // to their own shell exactly as before. Anything else (SOURCE) goes to the root
  // router, which knows where each role belongs.
  if (!(await canUsePortal(session.user))) {
    redirect(
      session.user.role === 'ADMIN' ? '/admin' : session.user.role === 'MENTOR' ? '/mentor' : '/'
    );
  }

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { avatarUrl: true, twoFactorEnabled: true },
  });
  const customStages = await resolveCustomStages(session.user.orgId);
  // The tenant's own competency framework, or null when it uses the built-in
  // criteria (#822) — same provider shape as the pipeline stages above.
  const customCriteria = await resolveCustomCriteria(session.user.orgId);
  const modes = await availableModes(session.user);

  // The 2FA gate lives on each staff shell; the portal needs it too now that a
  // role in scope for the policy can enter here — otherwise the portal would be
  // a way around the setup gate.
  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role))) {
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
          <p className="text-xs text-gray-500 mt-1">{t.panel.mentee}</p>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          <PortalNav />
          <InstallAppButton />
        </nav>

        <ModeSwitcher modes={modes} />

        <AccountMenu
          name={session.user.name}
          email={session.user.email}
          avatarUrl={me?.avatarUrl}
          fallback="M"
          avatarClassName="bg-purple-100 text-purple-700"
          accountHref="/account"
          locale={locale}
          version={APP_VERSION}
        />
        </aside>
      }
    >
      <PipelineStagesProvider stages={customStages}>
        <EvaluationCriteriaProvider criteria={customCriteria}>
  <PortalTabs />
  {children}
</EvaluationCriteriaProvider>
      </PipelineStagesProvider>
    </ResponsiveShell>
  );
}
