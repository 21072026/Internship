import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getServerDictionary } from '@/i18n/server';
import { requirePortalPartner } from '@/lib/affiliatePortal';
import { partnerCommissions } from '@/lib/affiliatePartnerView';
import { COMMISSION_STATUSES, type CommissionStatus } from '@/lib/affiliateCommissions';
import { formatMinorAmount } from '@/lib/money';
import { interpolate } from '@/lib/notificationText';
import { formatDate } from '@/lib/relativeTime';
import { PortalPager } from '../PortalPager';

const STATUS_VARIANT: Record<CommissionStatus, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  PENDING: 'warning',
  APPROVED: 'info',
  PAID: 'success',
  REJECTED: 'danger',
};

// The partner's own commissions (#3117), oldest due first, filterable by status.
export default async function AffiliateCommissionsPage({ searchParams }: { searchParams: Promise<{ page?: string; status?: string }> }) {
  const { locale, t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await requirePortalPartner();
  if (!portal) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.noPartner}</p>;

  const params = await searchParams;
  const data = await partnerCommissions(portal.partner, { status: params.status, page: params.page });
  const date = (iso: string) => formatDate(iso, locale, { timeZone: 'UTC' });
  const filter = (status: CommissionStatus | null, label: string) => {
    const active = data.status === status;
    return (
      <Link
        key={status ?? 'all'}
        href={status ? `/affiliate/commissions?status=${status}` : '/affiliate/commissions'}
        aria-current={active ? 'page' : undefined}
        className={`rounded-full px-3 py-1 text-sm ${active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300'}`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.commissionsTitle}</h1>
      <nav className="flex flex-wrap gap-2" aria-label={L.colStatus}>
        {filter(null, L.filterAll)}
        {COMMISSION_STATUSES.map((s) => filter(s, `${L[`status${s}`]} (${data.totals[s].count})`))}
      </nav>
      {data.total === 0 ? (
        <EmptyState testId="affiliate-commissions" icon={Receipt} title={L.commissionsEmpty} />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="affiliate-commissions-table">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-4 py-2">{L.colPaymentDate}</th>
                  <th className="px-4 py-2">{L.colCustomer}</th>
                  <th className="px-4 py-2">{L.colKind}</th>
                  <th className="px-4 py-2 text-right">{L.colPayment}</th>
                  <th className="px-4 py-2 text-right">{L.colCommission}</th>
                  <th className="px-4 py-2">{L.colDue}</th>
                  <th className="px-4 py-2">{L.colStatus}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-4 py-2 whitespace-nowrap">{date(r.accruedAt)}</td>
                    <td className="px-4 py-2 font-mono">{r.customerRef}</td>
                    <td className="px-4 py-2 whitespace-nowrap" data-testid="affiliate-commission-kind">
                      {L[`kind${r.kind}`]}
                      {r.planVersion > 0 && (
                        <span className="ml-1 text-gray-500">({interpolate(L.planVersionShort, { n: String(r.planVersion) })})</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{formatMinorAmount(r.paymentAmountMinor, r.currency, locale)}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap font-medium">{formatMinorAmount(r.amountMinor, r.currency, locale)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{date(r.dueAt)}</td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_VARIANT[r.status]}>{L[`status${r.status}`]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <PortalPager
        path="/affiliate/commissions"
        page={data.page}
        total={data.total}
        perPage={data.perPage}
        query={data.status ? { status: data.status } : {}}
        labels={L}
      />
    </div>
  );
}
