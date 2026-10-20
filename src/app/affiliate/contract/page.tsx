import { notFound, redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getServerDictionary } from '@/i18n/server';
import { affiliateOrgForRequest } from '@/lib/affiliateProgram';
import { localizedText, needsContractAcceptance, type LocaleMap } from '@/lib/affiliateContractRule';
import { AcceptContractButton } from './AcceptContractButton';

// The partner contract, shown in full on the organisation's own host. A partner
// accepts the current version here; a changed contract brings them back.
export default async function ContractPage() {
  const org = await affiliateOrgForRequest();
  if (!org) notFound();

  const session = await getServerSession(authOptions);
  if (!session) redirect('/auth/signin?callbackUrl=/affiliate/contract');
  if (session.user.role !== 'AFFILIATE' || session.user.orgId !== org.id) notFound();

  const settings = await prisma.affiliateProgramSettings.findUnique({
    where: { orgId: org.id },
    select: { contract: true, contractVersion: true },
  });
  if (!settings) notFound();

  const partner = await prisma.affiliatePartner.findFirst({
    where: { userId: session.user.id, orgId: org.id },
    select: { contractAcceptances: { select: { version: true } } },
  });
  if (!partner) notFound();
  if (!needsContractAcceptance(partner.contractAcceptances.map((a) => a.version), settings.contractVersion)) {
    redirect('/affiliate');
  }

  const { locale, t } = await getServerDictionary();
  const text = localizedText(settings.contract as LocaleMap, locale);

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">{t.affiliates.contractHeading}</h1>
      {text ? (
        <div className="whitespace-pre-line text-sm">{text}</div>
      ) : (
        <p className="text-sm">{t.affiliates.notConfigured}</p>
      )}
      {text && (
        <AcceptContractButton version={settings.contractVersion} label={t.affiliates.acceptButton} failed={t.affiliates.acceptFailed} />
      )}
    </main>
  );
}
