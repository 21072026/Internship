import Link from 'next/link';
import { FileText } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getServerDictionary } from '@/i18n/server';
import { prisma } from '@/lib/prisma';
import { portalPartner } from '@/lib/affiliatePortal';
import { contractTextFor, readStoredContract } from '@/lib/affiliateContractRule';
import { interpolate } from '@/lib/notificationText';
import { formatDate } from '@/lib/relativeTime';
import { AcceptContract } from './AcceptContract';

// The partner contract (docs/affiliate-module.md, #3117): the one portal page a
// partner reaches before accepting the current version. The text is plain text,
// shown as written (no markup is interpreted).
export default async function AffiliateContractPage() {
  const { locale, t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await portalPartner();
  if (!portal) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.noPartner}</p>;

  const { partner, contract, impersonating } = portal;
  const [settings, acceptance] = await Promise.all([
    prisma.affiliateProgramSettings.findUnique({ where: { orgId: partner.orgId }, select: { contract: true } }),
    contract.currentVersion > 0
      ? prisma.affiliateContractAcceptance.findUnique({
          where: { partnerId_version: { partnerId: partner.id, version: contract.currentVersion } },
          select: { acceptedAt: true },
        })
      : null,
  ]);
  const text = contractTextFor(readStoredContract(settings?.contract), locale);

  if (contract.currentVersion === 0 || !text) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.contractTitle}</h1>
        <EmptyState testId="affiliate-contract-none" icon={FileText} title={L.contractNone} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.contractTitle}</h1>
        <p className="text-sm text-gray-500">{interpolate(L.contractVersion, { n: String(contract.currentVersion) })}</p>
      </div>
      {contract.mustAccept && (
        <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="affiliate-contract-intro">
          {contract.acceptedVersion > 0 ? interpolate(L.contractChanged, { n: String(contract.acceptedVersion) }) : L.contractIntro}
        </p>
      )}
      <Card>
        <div
          lang={text.locale}
          className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-800 dark:text-gray-200"
          data-testid="affiliate-contract-text"
          role="region"
          aria-label={L.contractTitle}
          tabIndex={0}
        >
          {text.text}
        </div>
      </Card>
      {contract.mustAccept ? (
        <AcceptContract version={contract.currentVersion} impersonating={impersonating} />
      ) : (
        <div className="space-y-2">
          {acceptance && (
            <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-contract-accepted">
              {interpolate(L.contractAccepted, { date: formatDate(acceptance.acceptedAt, locale) })}
            </p>
          )}
          <Link href="/affiliate" className="text-sm font-medium text-blue-600 hover:underline">
            {L.toPortal}
          </Link>
        </div>
      )}
    </div>
  );
}
