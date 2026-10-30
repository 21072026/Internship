'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Circle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useLocale, useT } from '@/i18n/client';
import { formatMinorAmount } from '@/lib/money';
import { formatDate } from '@/lib/relativeTime';
import { interpolate } from '@/lib/notificationText';
import type { AffiliateOverview } from '@/lib/affiliateOverview';
import { AffiliateTabs } from './AffiliateTabs';

// The partner programme's home (docs/affiliate-module.md, #3173): what the
// programme holds now, read through GET /api/admin/affiliate/overview — the same
// totals the Commissions and Payouts tabs show — with shortcuts to the work
// waiting, and the setup steps while any of them is still open.
const COMMISSION_STATUSES = ['PENDING', 'APPROVED', 'PAID', 'REJECTED'] as const;
const PARTNER_STATUSES = ['ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;

export default function AdminAffiliatesPage() {
  const t = useT();
  const L = t.affiliateAdmin;
  const C = t.affiliateCommissions;
  const locale = useLocale();
  const [data, setData] = useState<AffiliateOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/admin/affiliate/overview');
      if (res.status === 403) setForbidden(true);
      else if (!res.ok) setFailed(true);
      else setData(await res.json());
    })();
  }, []);

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{L.noAccess}</p>;
  const money = (minor: number, currency = data?.currency ?? 'EUR') => formatMinorAmount(minor, currency, locale);
  const steps = data
    ? [
        { key: 'plan', done: data.setup.plan, label: L.stepPlan, href: '/admin/affiliates/settings' },
        { key: 'contract', done: data.setup.contract, label: L.stepContract, href: '/admin/affiliates/settings' },
        { key: 'partner', done: data.setup.partners, label: L.stepPartner, href: '/admin/affiliates/partners' },
      ]
    : [];
  const partnerTotal = data ? PARTNER_STATUSES.reduce((n, s) => n + data.partners[s], 0) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{L.title}</h1>
      <AffiliateTabs />
      {failed ? (
        <p className="text-sm text-red-600" role="alert">{L.overviewFailed}</p>
      ) : !data ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          {steps.some((s) => !s.done) && (
            <Card data-testid="affiliate-overview-setup">
              <CardHeader>
                <CardTitle>{L.setupTitle}</CardTitle>
                <p className="text-sm text-gray-600 dark:text-gray-400">{L.setupBody}</p>
              </CardHeader>
              <ol className="space-y-2">
                {steps.map((s, i) => (
                  <li key={s.key} className="flex items-center gap-2 text-sm" data-testid={`affiliate-setup-${s.key}`} data-done={s.done ? 'true' : 'false'}>
                    {s.done ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden />
                    ) : (
                      <Circle className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
                    )}
                    <span className="text-gray-900 dark:text-gray-100">{`${i + 1}. ${s.label}`}</span>
                    {s.done ? (
                      <span className="text-gray-500">{L.stepDone}</span>
                    ) : (
                      <Link href={s.href} className="text-blue-600 hover:underline dark:text-blue-400">
                        {L.stepOpen}
                      </Link>
                    )}
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {(data.setup.partners || data.commissions.PENDING.count + data.commissions.APPROVED.count + data.commissions.PAID.count > 0) && (
            <>
              <div className="flex flex-wrap gap-3">
                {data.commissions.PENDING.count > 0 && (
                  <Link
                    href="/admin/affiliates/commissions?status=PENDING"
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    data-testid="affiliate-overview-to-approve"
                  >
                    {interpolate(L.toApprove, { count: String(data.commissions.PENDING.count), amount: money(data.commissions.PENDING.amountMinor) })}
                  </Link>
                )}
                {data.commissions.APPROVED.count > 0 && (
                  <Link
                    href="/admin/affiliates/payouts"
                    className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    data-testid="affiliate-overview-to-pay"
                  >
                    {interpolate(L.toPay, { count: String(data.commissions.APPROVED.count), amount: money(data.commissions.APPROVED.amountMinor) })}
                  </Link>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Card data-testid="affiliate-overview-partners">
                  <CardHeader>
                    <CardTitle>{L.partnersTitle}</CardTitle>
                  </CardHeader>
                  <p className="text-3xl font-semibold text-gray-900 dark:text-gray-100">{partnerTotal}</p>
                  <dl className="mt-2 space-y-1 text-sm">
                    {PARTNER_STATUSES.map((s) => (
                      <div key={s} className="flex justify-between gap-2">
                        <dt className="text-gray-600 dark:text-gray-400">{L[`partners${s}`]}</dt>
                        <dd className="tabular-nums text-gray-900 dark:text-gray-100" data-testid={`affiliate-overview-partners-${s}`}>{data.partners[s]}</dd>
                      </div>
                    ))}
                    <div className="flex justify-between gap-2 border-t border-gray-100 pt-1 dark:border-gray-800">
                      <dt className="text-gray-600 dark:text-gray-400">{L.customers}</dt>
                      <dd className="tabular-nums text-gray-900 dark:text-gray-100" data-testid="affiliate-overview-customers">{data.customers}</dd>
                    </div>
                  </dl>
                </Card>

                <Card data-testid="affiliate-overview-commissions">
                  <CardHeader>
                    <CardTitle>{L.commissionsTitle}</CardTitle>
                  </CardHeader>
                  <dl className="space-y-1 text-sm">
                    {COMMISSION_STATUSES.map((s) => (
                      <div key={s} className="flex justify-between gap-2">
                        <dt className="text-gray-600 dark:text-gray-400">
                          <Link href={`/admin/affiliates/commissions?status=${s}`} className="hover:underline">
                            {C[`status${s}`]}
                          </Link>
                        </dt>
                        <dd className="tabular-nums text-gray-900 dark:text-gray-100" data-testid={`affiliate-overview-commissions-${s}`}>
                          {interpolate(C.total, { count: String(data.commissions[s].count), amount: money(data.commissions[s].amountMinor) })}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </Card>

                <Card data-testid="affiliate-overview-payouts">
                  <CardHeader>
                    <CardTitle>{L.payoutsTitle}</CardTitle>
                  </CardHeader>
                  <p className="text-sm text-gray-900 dark:text-gray-100" data-testid="affiliate-overview-payouts-total">
                    {interpolate(L.payoutsTotal, { count: String(data.payouts.count), amount: money(data.payouts.amountMinor) })}
                  </p>
                  {data.latestPayout ? (
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-400" data-testid="affiliate-overview-latest-payout">
                      {interpolate(L.latestPayout, {
                        amount: money(data.latestPayout.amountMinor, data.latestPayout.currency),
                        partner: data.latestPayout.partner.displayName,
                        date: formatDate(data.latestPayout.paidAt, locale, { timeZone: 'UTC' }),
                      })}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-gray-500">{L.noPayouts}</p>
                  )}
                </Card>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
