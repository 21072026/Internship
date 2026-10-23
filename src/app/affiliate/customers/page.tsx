import { Users } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getServerDictionary } from '@/i18n/server';
import { requirePortalPartner } from '@/lib/affiliatePortal';
import { partnerCustomers } from '@/lib/affiliatePartnerView';
import { AFFILIATE_CURRENCIES } from '@/lib/affiliateProgramSettings';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { PortalPager } from '../PortalPager';

// The partner's own customers (#3117): the customer's opaque reference, since
// when it is credited to the partner, its payments and what it earned so far.
export default async function AffiliateCustomersPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { locale, t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await requirePortalPartner();
  if (!portal) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.noPartner}</p>;

  const data = await partnerCustomers(portal.partner, (await searchParams).page);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.customersTitle}</h1>
      {data.total === 0 ? (
        <EmptyState testId="affiliate-customers" icon={Users} title={L.customersEmpty} />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="affiliate-customers-table">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-4 py-2">{L.colCustomer}</th>
                  <th className="px-4 py-2">{L.colSince}</th>
                  <th className="px-4 py-2 text-right">{L.colPayments}</th>
                  <th className="px-4 py-2 text-right">{L.colEarned}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-4 py-2 font-mono">{r.ref}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.since, locale, { timeZone: 'UTC' })}</td>
                    <td className="px-4 py-2 text-right">{r.payments}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{formatMinorAmount(r.earnedMinor, AFFILIATE_CURRENCIES[0], locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <PortalPager path="/affiliate/customers" page={data.page} total={data.total} perPage={data.perPage} labels={L} />
    </div>
  );
}
