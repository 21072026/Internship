import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { is2faRequiredFor } from '@/lib/twoFactorPolicy';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { roleHome } from '@/lib/roleHome';
import { getServerDictionary } from '@/i18n/server';
import { AccountMenu } from '@/components/AccountMenu';
import { BrandWordmark } from '@/components/BrandWordmark';
import { ResponsiveShell } from '@/components/ResponsiveShell';
import { APP_VERSION } from '@/lib/version';
import { PartnerSidebar } from './PartnerSidebar';
import { affiliateOrgForRequest } from '@/lib/affiliateProgram';
import { needsContractAcceptance } from '@/lib/affiliateContractRule';

// The partner portal's shell (docs/affiliate-module.md). Gate order matches the
// other role shells: session, then 2FA (before any redirect that could send the
// person elsewhere), then role, then the vertical's capability. The shell is the
// same one the marketing CRM uses: brand, a left menu with sign-out, and the
// account menu in the header.
export default async function AffiliateLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin');

  const me = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { avatarUrl: true, twoFactorEnabled: true },
  });
  if (!session.user.impersonatorId && !me?.twoFactorEnabled && (await is2faRequiredFor(session.user.role, await settingsOrgOf(session)))) {
    redirect('/security-setup');
  }

  if (session.user.role !== 'AFFILIATE') redirect(roleHome(session.user.role));

  const capabilities = await shellCapabilities(session.user.orgId);
  if (!capabilities.includes('affiliate')) notFound();

  // The host must belong to the partner's own organisation: a partner of one programme
  // does not get another organisation's portal by visiting its host.
  const hostOrg = await affiliateOrgForRequest();
  if (!hostOrg || hostOrg.id !== session.user.orgId) notFound();

  // A partner must accept the current contract before the portal opens.
  const settings = await prisma.affiliateProgramSettings.findUnique({
    where: { orgId: hostOrg.id },
    select: { contractVersion: true },
  });
  if (settings) {
    const partner = await prisma.affiliatePartner.findFirst({
      where: { userId: session.user.id, orgId: hostOrg.id },
      select: { contractAcceptances: { select: { version: true } } },
    });
    if (!partner || needsContractAcceptance(partner.contractAcceptances.map((a) => a.version), settings.contractVersion)) {
      redirect('/affiliate/contract');
    }
  }

  const { locale, t } = await getServerDictionary();
  const labels = {
    portal: t.affiliates.navPortal,
    account: t.affiliates.navAccount,
  };

  return (
    <ResponsiveShell
      brand={<BrandWordmark oneLine />}
      sidebar={
        <PartnerSidebar
          brand={<BrandWordmark />}
          account={
            <AccountMenu
              name={session.user.name}
              email={session.user.email}
              avatarUrl={me?.avatarUrl}
              fallback="P"
              avatarClassName="bg-amber-100 text-amber-700"
              accountHref="/account"
              locale={locale}
              version={APP_VERSION}
            />
          }
          labels={labels}
        />
      }
    >
      <main className="mx-auto max-w-3xl p-4 md:p-6">{children}</main>
    </ResponsiveShell>
  );
}
