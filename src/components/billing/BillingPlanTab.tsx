'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Gauge, History, HeartHandshake } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { LoadErrorCard } from '@/components/ui/LoadErrorCard';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';
import { formatCount, formatEur, formatEurCents } from '@/lib/money';
import { formatDate, formatDateTime } from '@/lib/relativeTime';
import type { BillingSummary } from '@/lib/billingSummary';
import { PlanChangeRequestCard } from '@/components/billing/PlanChangeRequestCard';

// The first tab of /admin/billing (#1739): plan card, this month's active-pair
// meter against the band, the over-band state and twelve months of history.
// Reads GET /api/org/billing only — the pair count is the nightly rollup's
// (docs/metering.md), so a month not computed yet says so instead of a number.

function periodLabel(period: string, locale: string) {
  return formatDate(`${period}-01T00:00:00Z`, locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function BillingPlanTab() {
  const t = useT();
  const b = t.billing;
  const locale = useLocale();
  const [data, setData] = useState<BillingSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    fetch('/api/org/billing')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: BillingSummary) => setData(d))
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (failed) return <LoadErrorCard onRetry={load} testId="billing-load-error" />;
  if (!data) return <SkeletonRows rows={4} />;

  const cur = data.currentPeriod;
  const yearly = data.billingCycle === 'YEARLY';
  const price = yearly ? data.pricing.annualTotalEur : data.pricing.monthlyEur;
  const pct = cur.activePairs != null && data.band ? Math.min(100, Math.round((cur.activePairs / data.band) * 100)) : 0;
  const over = cur.overBand > 0;

  return (
    <div className="space-y-6">
      <Card data-testid="billing-plan-card">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-blue-600" aria-hidden />
            <CardTitle>{b.plan.title}</CardTitle>
          </div>
        </CardHeader>
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="text-xl font-semibold text-gray-900 dark:text-gray-100" data-testid="billing-plan-name">
            {data.plan.name}
          </span>
          <Badge variant={data.statusCarriesPlan ? 'success' : 'warning'} data-testid="billing-plan-status">
            {b.plan.status[data.status as keyof typeof b.plan.status] ?? data.status}
          </Badge>
          {data.educationDiscount && (
            <Badge variant="info" data-testid="billing-education-discount">
              {b.plan.educationDiscount}
            </Badge>
          )}
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{b.plan.cycle}</dt>
            <dd className="text-gray-900 dark:text-gray-100">{b.plan.cycles[data.billingCycle as keyof typeof b.plan.cycles] ?? data.billingCycle}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{b.plan.price}</dt>
            <dd className="text-gray-900 dark:text-gray-100" data-testid="billing-plan-price">
              {price == null ? b.plan.priceOnRequest : `${formatEur(price, locale)} ${yearly ? b.plan.perYear : b.plan.perMonth}`}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">{data.cancelAtPeriodEnd ? b.plan.endsOn : b.plan.renewsOn}</dt>
            <dd className="text-gray-900 dark:text-gray-100">{data.renewsAt ? formatDate(data.renewsAt, locale) : b.plan.noRenewal}</dd>
          </div>
        </dl>
        {!data.plan.published && <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{b.plan.unpublished}</p>}
        {!data.statusCarriesPlan && <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{b.plan.statusNotEntitling}</p>}
        <div className="mt-4">
          {/* The request form below files it (POST /api/org/plan-change, #1743). */}
          <a href="#plan-change" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400" data-testid="billing-change-plan">
            {b.changePlan}
          </a>
        </div>
      </Card>

      <Card data-testid="billing-meter">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-blue-600" aria-hidden />
            <CardTitle>{fillTemplate(b.meter.title, { period: periodLabel(cur.period, locale) })}</CardTitle>
          </div>
        </CardHeader>
        {cur.activePairs == null ? (
          <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="billing-meter-pending">
            {b.meter.notComputed}
          </p>
        ) : (
          <>
            <p className="text-3xl font-semibold text-gray-900 dark:text-gray-100">
              <span data-testid="billing-active-pairs">{formatCount(cur.activePairs, locale, b.meter.unlimited)}</span>
              <span className="ml-2 text-base font-normal text-gray-500 dark:text-gray-400" data-testid="billing-band">
                {fillTemplate(b.meter.ofBand, { band: formatCount(data.band, locale, b.meter.unlimited) })}
              </span>
            </p>
            {data.band != null && (
              <div
                className="mt-3 h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={data.band}
                aria-valuenow={cur.activePairs}
                aria-label={b.meter.label}
              >
                <div className={`h-2 rounded-full ${over ? 'bg-red-500' : 'bg-blue-600'}`} style={{ width: `${pct}%` }} />
              </div>
            )}
            {cur.computedAt && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {fillTemplate(b.meter.asOf, { when: formatDateTime(cur.computedAt, locale) })}
              </p>
            )}
          </>
        )}
        <p className="mt-4 text-sm text-gray-600 dark:text-gray-300">
          {b.meter.definition}{' '}
          <Link href="/pricing" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
            {b.meter.pricingLink}
          </Link>
        </p>

        {over && (
          <div className="mt-4 rounded-lg border border-red-200 p-3 text-sm dark:border-red-900" data-testid="billing-over-band">
            <p className="font-medium text-gray-900 dark:text-gray-100">{fillTemplate(b.overBand.title, { n: String(cur.overBand) })}</p>
            <p className="mt-1 text-gray-600 dark:text-gray-300">
              {cur.overageCents != null && data.pricing.overagePerPairCents != null
                ? fillTemplate(b.overBand.cost, {
                    amount: formatEurCents(cur.overageCents, locale),
                    rate: formatEurCents(data.pricing.overagePerPairCents, locale),
                  })
                : b.overBand.hardCap}
            </p>
            <p className="mt-1 text-gray-600 dark:text-gray-300">
              {b.overBand.moveUp}{' '}
              <a href="#plan-change" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                {b.changePlan}
              </a>
            </p>
          </div>
        )}
      </Card>

      <div id="plan-change" className="scroll-mt-4">
        <PlanChangeRequestCard currentPlan={data.plan.key} />
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-gray-200 p-3 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-200" data-testid="billing-free-core">
        <HeartHandshake className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-hidden />
        <p>{b.freeCore}</p>
      </div>

      <Card data-testid="billing-history">
        <CardHeader>
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-blue-600" aria-hidden />
            <CardTitle>{b.history.title}</CardTitle>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400">
                <th scope="col" className="py-2 pr-4 font-medium">{b.history.period}</th>
                <th scope="col" className="py-2 pr-4 font-medium text-right">{b.history.activePairs}</th>
                <th scope="col" className="py-2 font-medium text-right">{b.history.adminSeats}</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((m) => (
                <tr key={m.period} className="border-t border-gray-100 dark:border-gray-800" data-testid={`billing-history-${m.period}`}>
                  <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">{periodLabel(m.period, locale)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums text-gray-900 dark:text-gray-100">{m.activePairs ?? '—'}</td>
                  <td className="py-2 text-right tabular-nums text-gray-900 dark:text-gray-100">{m.adminSeats ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{b.history.note}</p>
      </Card>
    </div>
  );
}
