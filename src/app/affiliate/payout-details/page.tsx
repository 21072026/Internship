import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { getServerDictionary } from '@/i18n/server';
import { requirePortalPartner } from '@/lib/affiliatePortal';
import { maskedPayoutDetails } from '@/lib/affiliatePayoutDetails';
import { interpolate } from '@/lib/notificationText';
import { PayoutDetailsForm } from './PayoutDetailsForm';

// The partner's own bank details (#3117). The stored IBAN is shown masked (its
// last four characters); a change goes through PUT /api/affiliate/me/payout-details,
// which validates, seals, audits and announces it (src/lib/affiliatePayoutDetails.ts).
export default async function AffiliatePayoutDetailsPage() {
  const { t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await requirePortalPartner();
  if (!portal) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.noPartner}</p>;

  const current = await maskedPayoutDetails(portal.partner.orgId, portal.partner.id);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.detailsTitle}</h1>
      <Card>
        <CardHeader>
          <CardTitle>{L.detailsTitle}</CardTitle>
          <p className="text-sm text-gray-600 dark:text-gray-400">{L.detailsHint}</p>
          <p className="text-sm text-gray-800 dark:text-gray-200" data-testid="affiliate-payout-current">
            {current ? interpolate(L.detailsCurrent, { iban: current.iban, holder: current.holder }) : L.detailsNone}
          </p>
        </CardHeader>
        <PayoutDetailsForm impersonating={portal.impersonating} suspended={portal.partner.status === 'SUSPENDED'} />
      </Card>
    </div>
  );
}
