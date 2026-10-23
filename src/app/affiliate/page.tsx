import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { getServerDictionary } from '@/i18n/server';
import { CONTRACT_PATH, requirePortalPartner } from '@/lib/affiliatePortal';

// The partner portal's home (docs/affiliate-module.md). A partner who has not
// accepted the current contract is sent to it first. Link, customers and
// commissions follow with the portal step.
export default async function AffiliateHomePage() {
  const { t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await requirePortalPartner();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
      {!portal ? (
        <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-no-partner">{L.noPartner}</p>
      ) : (
        <>
          <EmptyState testId="affiliate-portal" icon={Wallet} title={L.title} body={L.emptyBody} />
          {portal.contract.currentVersion > 0 && (
            <Link href={CONTRACT_PATH} className="text-sm font-medium text-blue-600 hover:underline">
              {L.viewContract}
            </Link>
          )}
        </>
      )}
    </div>
  );
}
