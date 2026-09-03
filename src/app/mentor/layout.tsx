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
import { InstallAppButton } from '@/components/InstallAppButton';
import { GlobalSearch } from '@/components/GlobalSearch';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { PipelineStagesProvider } from '@/lib/pipelineStagesClient';
import { resolveCustomStages } from '@/lib/pipelineStages';
import { EvaluationCriteriaProvider } from '@/lib/evaluationCriteriaClient';
import { resolveCustomCriteria } from '@/lib/evaluationTemplates';
import { ModeSwitcher } from '@/components/ModeSwitcher';
import { MentorNav } from '@/components/MentorNav';
import { availableModes, canUseMentorShell } from '@/lib/dualRole';

export default async function MentorLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect('/auth/signin');
  }

  // A mentee-role account gets in too, but only once someone has actually been
  // assigned to them to mentor (#1141) — the same dual-role symmetry that lets a
  // mentor be mentored. With nobody to mentor, this shell is empty for them.
  if (!(await canUseMentorShell(session.user))) {
    redirect('/');
  }

  const { locale, t } = await getServerDictionary();
  const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { avatarUrl: true, twoFactorEnabled: true } });
  const customStages = await resolveCustomStages(session.user.orgId);
  // The tenant's own competency framework, or null when it uses the built-in
  // criteria (#822) — same provider shape as the pipeline stages above.
  const customCriteria = await resolveCustomCriteria(session.user.orgId);
  const modes = await availableModes(session.user);

  // Auth hardening: hold in-scope roles at the 2FA setup gate until enabled.
  // Skipped while impersonating (the admin behind it is already authenticated).
  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role))) {
    redirect('/security-setup');
  }

  return (
    <>
      {/* Mounted once per authenticated shell: ⌘K / Ctrl+K and `?` (#2079). */}
      <CommandPalette role="MENTOR" />
    <ResponsiveShell
      brand={<BrandWordmark oneLine />}
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

        {/* Admins reach this shell to work their own mentees, and a mentor who is
            mentored in turn reaches the portal from here; the switch is both the
            way back and the marker that says why the layout looks different. */}
        <ModeSwitcher modes={modes} />

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
      <PipelineStagesProvider stages={customStages}>
        <EvaluationCriteriaProvider criteria={customCriteria}>{children}</EvaluationCriteriaProvider>
      </PipelineStagesProvider>
    </ResponsiveShell>
    </>
  );
}
