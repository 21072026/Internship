import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@/components/ui/Card';
import { getServerDictionary } from '@/i18n/server';
import { requirePortalPartner } from '@/lib/affiliatePortal';
import { partnerPayout } from '@/lib/affiliatePartnerView';
import { formatMinorAmount } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { formatDate } from '@/lib/relativeTime';

// One of the partner's payouts with the commissions it paid (#3117). Another
// partner's payout reads exactly like one that does not exist: 404.
export default async function AffiliatePayoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { locale, t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await requirePortalPartner();
  if (!portal) notFound();
  const payout = await partnerPayout(portal.partner, (await params).id);
  if (!payout) notFound();

  const date = (iso: string) => formatDate(iso, locale, { timeZone: 'UTC' });
  return (
    <div className="space-y-6">
      <Link href="/affiliate/payouts" className="text-sm font-medium text-blue-600 hover:underline">
        {L.allPayouts}
      </Link>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{interpolate(L.payoutTitle, { date: date(payout.paidAt) })}</h1>
        <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100" data-testid="affiliate-payout-amount">
          {formatMinorAmount(payout.amountMinor, payout.currency, locale)}
        </p>
        {payout.reference && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {L.colReference}: <span className="font-mono">{payout.reference}</span>
          </p>
        )}
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="affiliate-payout-commissions">
            <thead className="text-left text-gray-500">
              <tr>
                <th className="px-4 py-2">{L.colPaymentDate}</th>
                <th className="px-4 py-2">{L.colCustomer}</th>
                <th className="px-4 py-2 text-right">{L.colCommission}</th>
              </tr>
            </thead>
            <tbody>
              {payout.commissions.map((c) => (
                <tr key={c.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-4 py-2 whitespace-nowrap">{date(c.accruedAt)}</td>
                  <td className="px-4 py-2 font-mono">{c.customerRef}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">{formatMinorAmount(c.amountMinor, c.currency, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
