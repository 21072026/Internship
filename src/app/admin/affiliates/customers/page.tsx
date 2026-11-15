'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { CustomerName } from '@/components/affiliate/CustomerName';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import { AffiliateTabs } from '../AffiliateTabs';

// The programme's referred customers, one row each (docs/affiliate-module.md
// § Customers, #3538). Read-only: payments are recorded, and the partner-facing
// label edited, on the customer payments screen.

type Window = { kind: 'none' } | { kind: 'unlimited' } | { kind: 'ends'; endsAt: string; ended: boolean };
interface Row {
  id: string;
  ref: string;
  label: string | null;
  partner: { id: string; code: string; displayName: string };
  firstPaymentAt: string | null;
  lastPaymentAt: string | null;
  payments: number;
  window: Window;
  earnedMinor: number;
}
interface Data {
  rows: Row[];
  total: number;
  page: number;
  perPage: number;
  showWindow: boolean;
  currency: string;
}

export default function AffiliateCustomersPage() {
  const t = useT();
  const L = t.affiliateCustomers;
  const locale = useLocale();
  const [data, setData] = useState<Data | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let live = true;
    void fetch(`/api/admin/affiliate/customers?page=${page}`)
      .then(async (res) => {
        if (!live) return;
        if (res.status === 403) return setForbidden(true);
        if (!res.ok) return setFailed(true);
        setData(await res.json());
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [page]);

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{t.affiliateAdmin.noAccess}</p>;
  if (failed) return <p className="text-sm text-red-600" role="alert">{L.failed}</p>;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;
  // Payment days are calendar days (UTC midnight), like the payments screen.
  const day = (iso: string | null) => (iso ? formatDate(iso, locale, { timeZone: 'UTC' }) : <span className="text-gray-500 dark:text-gray-400">{L.noPayment}</span>);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.affiliateAdmin.title}</h1>
      <AffiliateTabs />
      <p className="text-sm text-gray-600 dark:text-gray-400">{L.intro}</p>

      {!data ? (
        <SkeletonRows rows={5} />
      ) : data.rows.length === 0 ? (
        <EmptyState testId="affiliate-customers" title={L.empty} />
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="affiliate-customer-table">
              <thead className="text-left text-gray-500 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-2">{L.colCustomer}</th>
                  <th className="px-4 py-2">{L.colPartner}</th>
                  <th className="px-4 py-2">{L.colFirst}</th>
                  <th className="px-4 py-2">{L.colLast}</th>
                  <th className="px-4 py-2 text-right">{L.colPayments}</th>
                  {data.showWindow && <th className="px-4 py-2">{L.colWindow}</th>}
                  <th className="px-4 py-2 text-right">{L.colEarned}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800" data-testid="affiliate-customer-row" data-customer-id={r.id}>
                    <td className="px-4 py-2">
                      <CustomerName label={r.label} reference={r.ref} />
                    </td>
                    <td className="px-4 py-2">{r.partner.displayName}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{day(r.firstPaymentAt)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{day(r.lastPaymentAt)}</td>
                    <td className="px-4 py-2 text-right">{r.payments}</td>
                    {data.showWindow && (
                      <td className="px-4 py-2 whitespace-nowrap" data-testid="affiliate-customer-window" data-window={r.window.kind}>
                        {r.window.kind === 'none' ? (
                          <span className="text-gray-400" aria-label={L.windowNone}>{L.windowNone}</span>
                        ) : r.window.kind === 'unlimited' ? (
                          L.windowUnlimited
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            {/* UTC, like the engine's window end and the notice mail. */}
                            {formatDate(r.window.endsAt, locale, { timeZone: 'UTC' })}
                            {r.window.ended && <Badge variant="default">{L.windowEnded}</Badge>}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="px-4 py-2 text-right whitespace-nowrap">{formatMinorAmount(r.earnedMinor, data.currency, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 text-sm">
              <Button type="button" size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{L.prev}</Button>
              <span>{interpolate(L.page, { page: String(page), pages: String(pages) })}</span>
              <Button type="button" size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>{L.next}</Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
