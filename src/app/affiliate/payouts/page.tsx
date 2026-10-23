import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getServerDictionary } from '@/i18n/server';
import { requirePortalPartner } from '@/lib/affiliatePortal';
import { partnerPayouts } from '@/lib/affiliatePartnerView';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { PortalPager } from '../PortalPager';

// The partner's own payouts (#3117), newest transfer first.
export default async function AffiliatePayoutsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { locale, t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await requirePortalPartner();
  if (!portal) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.noPartner}</p>;

  const data = await partnerPayouts(portal.partner, (await searchParams).page);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.payoutsTitle}</h1>
      {data.total === 0 ? (
        <EmptyState testId="affiliate-payouts" icon={Wallet} title={L.payoutsEmpty} />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="affiliate-payouts-table">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-4 py-2">{L.colPaidOn}</th>
                  <th className="px-4 py-2 text-right">{L.colCommission}</th>
                  <th className="px-4 py-2 text-right">{L.colCount}</th>
                  <th className="px-4 py-2">{L.colReference}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-4 py-2 whitespace-nowrap">
                      <Link href={`/affiliate/payouts/${r.id}`} className="font-medium text-blue-600 hover:underline">
                        {formatDate(r.paidAt, locale, { timeZone: 'UTC' })}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap font-medium">{formatMinorAmount(r.amountMinor, r.currency, locale)}</td>
                    <td className="px-4 py-2 text-right">{r.commissions}</td>
                    <td className="px-4 py-2 font-mono">{r.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <PortalPager path="/affiliate/payouts" page={data.page} total={data.total} perPage={data.perPage} labels={L} />
    </div>
  );
}
