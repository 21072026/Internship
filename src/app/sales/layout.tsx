import { NO_INDEX } from '@/lib/pageMetadata';
import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { BetaBadge } from '@/components/BetaBadge';
import { AccountMenu } from '@/components/AccountMenu';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { BrandWordmark } from '@/components/BrandWordmark';
import { InstallAppButton } from '@/components/InstallAppButton';
import { MentorNav } from '@/components/MentorNav';
import { getServerDictionary } from '@/i18n/server';
import { APP_VERSION } from '@/lib/version';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { PipelineStagesProvider } from '@/lib/pipelineStagesClient';
import { resolveCustomStages } from '@/lib/pipelineStages';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { roleHome } from '@/lib/roleHome';
import { hasSalesSurface, NEUTRAL_HOME } from '@/lib/salesSurface';
import { ModeSwitcher } from '@/components/ModeSwitcher';
import { availableModes } from '@/lib/dualRole';

// Signed-in area: never in a search result (#1376).
export const metadata = NO_INDEX;

// The sales surface shell (#2580): a MARKETING sales rep — a MENTOR of a
// vertical without the `mentorship` module — works here on their OWN records.
// Who gets in is one rule, src/lib/salesSurface.ts; every page below re-reads
// the session and scopes its own queries (owner + tenant), so this gate is the
// first door, not the only one.
//
// No loading.tsx under /sales on purpose: the detail pages answer notFound()
// for a record that is not the rep's, and under a Suspense boundary that would
// be a not-found screen served with a 200 (see src/app/(unstreamed)/admin).
//
// Nothing admin-only is mounted: no command palette and no global search (both
// route to admin/mentor pages), no mode switcher. Settings, users, invites,
// imports and deletes stay behind their ADMIN-only routes server-side. The mode
// switch appears only for an ADMIN who also sells (admin ↔ sales).
export default async function SalesLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  const capabilities = await shellCapabilities(session.user.orgId);
  if (!hasSalesSurface(session.user.role, capabilities)) {
    // Never back into a shell that sends this user here. An ADMIN has the admin
    // shell in every vertical; a vertical with mentorship (INTERNSHIP) has every
    // role's own shell — an INTERNSHIP mentor goes to /mentor, which never
    // redirects here for them. Anyone else in a mentorship-less vertical (a
    // lead, a customer login) goes to the terminal neutral page.
    const home =
      session.user.role === 'ADMIN' || capabilities.includes('mentorship') ? roleHome(session.user.role) : NEUTRAL_HOME;
    redirect(home);
  }

  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { avatarUrl: true, twoFactorEnabled: true },
  });
  // Same 2FA hold as every other authenticated shell; skipped while
  // impersonating (the admin behind it is already authenticated).
  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role))) {
    redirect('/security-setup');
  }

  const { locale, t } = await getServerDictionary();
  const modes = await availableModes(session.user);
  const customStages = await resolveCustomStages(session.user.orgId);

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
            <p className="text-xs text-gray-500 mt-1" data-testid="sales-panel-label">
              {t.panel.sales}
            </p>
          </div>

          <nav className="flex-1 p-4 space-y-1 overflow-y-auto" data-testid="sales-nav">
            <MentorNav capabilities={capabilities} set="sales" />
            <InstallAppButton />
          </nav>

          <ModeSwitcher modes={modes} />

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
      <PipelineStagesProvider stages={customStages}>{children}</PipelineStagesProvider>
    </ResponsiveShell>
  );
}
