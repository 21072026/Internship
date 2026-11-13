import Link from 'next/link';
import { Users } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { getServerDictionary } from '@/i18n/server';
import { requirePortalPartner } from '@/lib/affiliatePortal';
import { partnerCustomers } from '@/lib/affiliatePartnerView';
import { CUSTOMER_STATUSES, type CustomerStatus } from '@/lib/affiliateCustomerStatusRule';
import { AFFILIATE_CURRENCIES } from '@/lib/affiliateProgramSettings';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { PortalPager } from '../PortalPager';
import { recordRef } from '@/lib/affiliateRecordRefRule';
import { interpolate } from '@/lib/notificationText';
import { CustomerName } from '@/components/affiliate/CustomerName';

const STATUS_VARIANT: Record<CustomerStatus, 'default' | 'success' | 'warning' | 'info'> = {
  FREE_PERIOD: 'info',
  NEVER_PAID: 'default',
  ACTIVE: 'success',
  PASSIVE: 'warning',
};

// The partner's own customers (#3117): the customer's opaque reference, its
// status (#3542, filterable, #3543), since when it is credited to the partner,
// its payments, what it earned so far and — when the plan has a percent phase —
// until when its percent commission runs (#3557, the date the notice mail names).
export default async function AffiliateCustomersPage({ searchParams }: { searchParams: Promise<{ page?: string; status?: string }> }) {
  const { locale, t } = await getServerDictionary();
  const L = t.affiliatePortal;
  const portal = await requirePortalPartner();
  if (!portal) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.noPartner}</p>;

  const params = await searchParams;
  const data = await partnerCustomers(portal.partner, { page: params.page, status: params.status });
  const filter = (status: CustomerStatus | null, label: string) => {
    const active = data.status === status;
    return (
      <Link
        key={status ?? 'all'}
        href={status ? `/affiliate/customers?status=${status}` : '/affiliate/customers'}
        aria-current={active ? 'page' : undefined}
        data-testid={`affiliate-customers-filter-${status ?? 'all'}`}
        className={`rounded-full px-3 py-1 text-sm ${active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300'}`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.customersTitle}</h1>
      {data.all > 0 && (
        <nav className="flex flex-wrap gap-2" aria-label={L.colStatus}>
          {filter(null, `${L.filterAll} (${data.all})`)}
          {CUSTOMER_STATUSES.map((s) => filter(s, `${L[`customerStatus${s}`]} (${data.counts[s]})`))}
        </nav>
      )}
      {data.total === 0 ? (
        <EmptyState testId="affiliate-customers" icon={Users} title={L.customersEmpty} />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="affiliate-customers-table">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="px-4 py-2">{L.colCustomer}</th>
                  <th className="px-4 py-2">{L.colStatus}</th>
                  <th className="px-4 py-2">{L.colSince}</th>
                  <th className="px-4 py-2 text-right">{L.colPayments}</th>
                  <th className="px-4 py-2 text-right">{L.colEarned}</th>
                  {data.showWindow && (
                    <th className="px-4 py-2" title={L.colWindowEndHint}>
                      {L.colWindowEnd}
                    </th>
                  )}
                  <th className="px-4 py-2"><span className="sr-only">{L.ask}</span></th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800" data-testid={`affiliate-customer-${r.ref}`}>
                    <td className="px-4 py-2"><CustomerName label={r.label} reference={r.ref} /></td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_VARIANT[r.status]} data-testid="affiliate-customer-status" data-status={r.status}>
                        {L[`customerStatus${r.status}`]}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.since, locale, { timeZone: 'UTC' })}</td>
                    <td className="px-4 py-2 text-right">{r.payments}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{formatMinorAmount(r.earnedMinor, AFFILIATE_CURRENCIES[0], locale)}</td>
                    {data.showWindow && (
                      <td className="px-4 py-2 whitespace-nowrap" data-testid="affiliate-customer-window" data-window={r.window.kind} data-ends-at={r.window.kind === 'ends' ? r.window.endsAt : undefined}>
                        {r.window.kind === 'none' ? (
                          <span className="text-gray-400" aria-label={L.windowNone}>{L.windowNone}</span>
                        ) : r.window.kind === 'unlimited' ? (
                          L.windowUnlimited
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            {/* UTC, like the engine's window end and the notice mail. */}
                            {formatDate(r.window.endsAt, locale, { timeZone: 'UTC' })}
                            {r.window.ended && (
                              <Badge variant="default" data-testid="affiliate-customer-window-ended">
                                {L.windowEnded}
                              </Badge>
                            )}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/affiliate/support?record=${encodeURIComponent(recordRef('customer', r.id))}`}
                        className="whitespace-nowrap text-blue-700 hover:underline dark:text-blue-300"
                        aria-label={interpolate(L.askAbout, { customer: r.ref })}
                        data-testid="affiliate-ask"
                      >
                        {L.ask}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <PortalPager
        path="/affiliate/customers"
        page={data.page}
        total={data.total}
        perPage={data.perPage}
        query={data.status ? { status: data.status } : {}}
        labels={L}
      />
    </div>
  );
}
