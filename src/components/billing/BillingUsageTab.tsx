'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BarChart3, ShieldCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { LoadErrorCard } from '@/components/ui/LoadErrorCard';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';
import { formatCount } from '@/lib/money';
import { formatDate, formatDateTime } from '@/lib/relativeTime';
import type { UsageRow, UsageState, UsageSummary } from '@/lib/usageSummary';

// The usage tab of /admin/billing (#1763): every metered number against its
// plan limit, with a four-month sparkline. Reads GET /api/org/usage only — the
// nightly ledger, never a live count — and fetches it itself (the bill is the
// shell's, OrgBillingContext). The active-pair row is the same rollup row the
// plan tab shows.
//
// Dark mode: no tinted box carries mid-tone text here — the state is a Badge
// and a bar colour, the over-limit notice uses the neutral card.

const BADGE: Record<UsageState, 'success' | 'warning' | 'danger' | 'info' | 'default'> = {
  ok: 'success',
  approaching: 'warning',
  over: 'danger',
  unlimited: 'info',
  not_included: 'default',
  reported: 'default',
  pending: 'default',
};

const BAR: Partial<Record<UsageState, string>> = {
  ok: 'bg-blue-600',
  approaching: 'bg-amber-500',
  over: 'bg-red-500',
};

function periodLabel(period: string, locale: string, month: 'long' | 'short' = 'long') {
  return formatDate(`${period}-01T00:00:00Z`, locale, { month, year: 'numeric', timeZone: 'UTC' });
}

function Sparkline({ row, label }: { row: UsageRow; label: string }) {
  const values = row.history.map((h) => h.value);
  const max = Math.max(1, ...values.map((v) => v ?? 0), row.limit ?? 0);
  return (
    <div className="flex h-8 items-end gap-1" role="img" aria-label={label} data-testid={`usage-trend-${row.key}`}>
      {row.history.map((h) => (
        <div
          key={h.period}
          title={`${h.period}: ${h.value ?? '—'}`}
          className={`w-3 rounded-sm ${h.value == null ? 'bg-gray-200 dark:bg-gray-700' : 'bg-blue-400 dark:bg-blue-500'}`}
          style={{ height: `${h.value == null ? 8 : Math.max(8, Math.round(((h.value ?? 0) / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

export function BillingUsageTab({ goTo }: { goTo?: (tab: 'plan') => void }) {
  const t = useT();
  const u = t.billing.usage;
  const locale = useLocale();
  const [data, setData] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    fetch('/api/org/usage')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: UsageSummary) => setData(d))
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (failed) return <LoadErrorCard onRetry={load} testId="usage-load-error" />;
  if (!data) return <SkeletonRows rows={6} />;

  return (
    <div className="space-y-6">
      {data.anyOver && (
        <Card data-testid="usage-over-notice">
          <p className="font-medium text-gray-900 dark:text-gray-100">{u.overTitle}</p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{u.overBody}</p>
          <button
            type="button"
            onClick={() => goTo?.('plan')}
            className="mt-3 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
            data-testid="usage-upgrade"
          >
            {u.goToPlan}
          </button>
        </Card>
      )}

      <Card data-testid="usage-card">
        <CardHeader>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-blue-600" aria-hidden />
            <CardTitle>{fillTemplate(u.title, { period: periodLabel(data.period, locale) })}</CardTitle>
          </div>
        </CardHeader>
        <p className="text-sm text-gray-600 dark:text-gray-300">{u.intro}</p>
        {data.computedAt && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {fillTemplate(u.asOf, { when: formatDateTime(data.computedAt, locale) })}
          </p>
        )}

        <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
          {data.rows.map((row) => {
            const limited = row.state === 'ok' || row.state === 'approaching' || row.state === 'over';
            const pct = limited && row.limit ? Math.min(100, Math.round(((row.value ?? 0) / row.limit) * 100)) : 0;
            return (
              <li key={row.key} className="py-3" data-testid={`usage-row-${row.key}`} data-state={row.state}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-[12rem] flex-1">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{u.metric[row.key]}</p>
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      <span className="font-semibold" data-testid={`usage-value-${row.key}`}>
                        {row.value == null ? '—' : formatCount(row.value, locale, '')}
                      </span>
                      {row.limit != null && row.limit > 0 && (
                        <span className="ml-1 text-gray-500 dark:text-gray-400" data-testid={`usage-limit-${row.key}`}>
                          {fillTemplate(u.of, { limit: formatCount(row.limit, locale, '') })}
                        </span>
                      )}
                    </p>
                  </div>
                  <Badge variant={BADGE[row.state]} data-testid={`usage-state-${row.key}`}>
                    {u.state[row.state]}
                  </Badge>
                  <Sparkline row={row} label={u.trend} />
                </div>
                {limited && row.limit != null && (
                  <div
                    className="mt-2 h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={row.limit}
                    aria-valuenow={row.value ?? 0}
                    aria-label={u.metric[row.key]}
                  >
                    <div className={`h-1.5 rounded-full ${BAR[row.state] ?? 'bg-blue-600'}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
                {row.key === 'activePairs' && (
                  <p className="mt-2 text-xs text-gray-600 dark:text-gray-300" data-testid="usage-pair-definition">
                    {t.billing.meter.definition}{' '}
                    <Link href="/pricing" className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                      {t.billing.meter.pricingLink}
                    </Link>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card data-testid="usage-never-metered">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-green-600" aria-hidden />
            <CardTitle>{u.neverTitle}</CardTitle>
          </div>
        </CardHeader>
        <p className="text-sm text-gray-600 dark:text-gray-300">{u.neverBody}</p>
      </Card>
    </div>
  );
}
