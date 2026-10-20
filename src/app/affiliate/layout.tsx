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
import { APP_VERSION } from '@/lib/version';

// The partner portal's shell (docs/affiliate-module.md). Gate order matches the
// other role shells: session, then 2FA (before any redirect that could send the
// person elsewhere), then role, then the vertical's capability. The header is the
// partner's way out: the brand, and the account menu with sign-out.
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

  const { locale } = await getServerDictionary();

  return (
    <>
      <header className="flex items-center justify-between border-b px-4 py-3">
        <BrandWordmark />
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
      </header>
      <main className="mx-auto max-w-3xl p-4 md:p-6">{children}</main>
    </>
  );
}
