'use client';

import { Suspense, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useLocale, useT } from '@/i18n/client';
import { interpolate } from '@/lib/notificationText';
import { FUNNEL_PERIODS, type Funnel } from '@/lib/affiliateFunnelRule';
import { parseFunnelBoardQuery, type FunnelBadge, type FunnelBoardQuery, type FunnelSort } from '@/lib/affiliateFunnelBoardRule';
import type { FunnelBoard, FunnelBoardPartnerRow } from '@/lib/affiliateFunnelBoard';
import { AffiliateTabs } from '../AffiliateTabs';

// The partner funnel (docs/affiliate-module.md § Partner funnel, #3544): one row
// per partner — clicks, registrations, paying, active, passive, conversion and
// the customers left to the plan's switch — read through
// GET /api/admin/affiliate/funnel, which sorts and pages on the server. The
// period, sort and page live in the URL, so a link opens the same view.

type Data = FunnelBoard & { sort: FunnelSort; dir: 'asc' | 'desc'; page: number; pageSize: number; totalRows: number };

const COLUMNS: { key: FunnelSort; numeric: boolean }[] = [
  { key: 'partner', numeric: false },
  { key: 'clicks', numeric: true },
  { key: 'uniqueClicks', numeric: true },
  { key: 'registrations', numeric: true },
  { key: 'paying', numeric: true },
  { key: 'active', numeric: true },
  { key: 'passive', numeric: true },
  { key: 'registrationRate', numeric: true },
  { key: 'payingRate', numeric: true },
  { key: 'toThreshold', numeric: true },
];

const BADGE_CLASS: Record<FunnelBadge, string> = {
  CLICKS_NO_SIGNUPS: 'bg-red-100 text-red-800',
  MOSTLY_PASSIVE: 'bg-amber-100 text-amber-800',
  WINDOW_ENDING: 'bg-amber-100 text-amber-800',
};

export default function AffiliateFunnelPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={5} />}>
      <AffiliateFunnelScreen />
    </Suspense>
  );
}

function AffiliateFunnelScreen() {
  const t = useT();
  const L = t.affiliateFunnel;
  const A = t.affiliateAdmin;
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const parsed = parseFunnelBoardQuery(params);
  const query: FunnelBoardQuery = parsed.ok ? parsed.query : { period: 'month', sort: 'clicks', dir: 'desc', page: 1 };
  const qs = new URLSearchParams({ period: query.period, sort: query.sort, dir: query.dir, page: String(query.page) }).toString();

  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    void (async () => {
      const res = await fetch(`/api/admin/affiliate/funnel?${qs}`);
      if (!live) return;
      if (res.status === 403) setForbidden(true);
      else if (!res.ok) setFailed(true);
      else setData(await res.json());
    })();
    return () => {
      live = false;
    };
  }, [qs]);

  const go = (next: Partial<FunnelBoardQuery>) => {
    const q = { ...query, ...next };
    router.replace(`${pathname}?${new URLSearchParams({ period: q.period, sort: q.sort, dir: q.dir, page: String(q.page) })}`);
  };
  const sortBy = (key: FunnelSort) =>
    go({ sort: key, dir: query.sort === key ? (query.dir === 'asc' ? 'desc' : 'asc') : key === 'partner' ? 'asc' : 'desc', page: 1 });

  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const rate = (whole: number | null) => (whole === null ? '—' : pct.format(whole / 100));
  const threshold = (n: number | null) => (n === null ? '—' : n === 0 ? L.thresholdReached : String(n));

  if (forbidden) return <p className="text-sm text-gray-600 dark:text-gray-400">{A.noAccess}</p>;

  const pages = data ? Math.max(1, Math.ceil(data.totalRows / data.pageSize)) : 1;
  const cells = (c: Funnel & { registrationRate: number | null; payingRate: number | null }) => [c.clicks, c.uniqueClicks, c.registrations, c.paying, c.active, c.passive, rate(c.registrationRate), rate(c.payingRate)];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{A.title}</h1>
      <AffiliateTabs />
      <div className="space-y-2">
        <p className="text-sm text-gray-600 dark:text-gray-400">{L.intro}</p>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={L.period}>
          <span className="text-sm text-gray-600 dark:text-gray-400">{L.period}</span>
          {FUNNEL_PERIODS.map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={query.period === p ? 'primary' : 'secondary'}
              aria-pressed={query.period === p}
              onClick={() => go({ period: p, page: 1 })}
              data-testid={`affiliate-funnel-period-${p}`}
            >
              {L.periods[p]}
            </Button>
          ))}
        </div>
      </div>

      {failed ? (
        <p className="text-sm text-red-600" role="alert">{L.loadFailed}</p>
      ) : !data ? (
        <SkeletonRows rows={5} />
      ) : data.totalRows === 0 ? (
        <p className="text-sm text-gray-500" data-testid="affiliate-funnel-empty">{L.empty}</p>
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="affiliate-funnel-table">
              <thead className="text-left text-gray-500">
                <tr>
                  {COLUMNS.map((col) => {
                    const active = query.sort === col.key;
                    return (
                      <th
                        key={col.key}
                        className={`px-3 py-2 font-medium ${col.numeric ? 'text-right' : ''}`}
                        aria-sort={active ? (query.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      >
                        <button
                          type="button"
                          onClick={() => sortBy(col.key)}
                          className="inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-gray-100"
                          data-testid={`affiliate-funnel-sort-${col.key}`}
                        >
                          {L.columns[col.key]}
                          {active && (query.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {data.rows.map((r: FunnelBoardPartnerRow) => (
                  <tr key={r.partnerId} data-testid={`affiliate-funnel-row-${r.code}`} className="text-gray-900 dark:text-gray-100">
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.displayName}</div>
                      <div className="text-xs text-gray-500">
                        {r.code}
                        {r.status !== 'ACTIVE' && ` · ${A[`partners${r.status}`]}`}
                      </div>
                      {r.badges.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.badges.map((b) => (
                            <span
                              key={b}
                              title={b === 'WINDOW_ENDING' ? interpolate(L.badgeHints[b], { count: String(r.windowEndingSoon) }) : L.badgeHints[b]}
                              className={`rounded-full px-1.5 py-0.5 text-xs font-semibold ${BADGE_CLASS[b]}`}
                              data-testid={`affiliate-funnel-badge-${b}`}
                            >
                              {L.badges[b]}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    {cells(r).map((v, i) => (
                      <td key={i} className="px-3 py-2 text-right tabular-nums" data-testid={`affiliate-funnel-${r.code}-${COLUMNS[i + 1].key}`}>
                        {v}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right tabular-nums" data-testid={`affiliate-funnel-${r.code}-toThreshold`}>
                      {threshold(r.toThreshold)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-gray-200 font-semibold text-gray-900 dark:border-gray-700 dark:text-gray-100">
                <tr data-testid="affiliate-funnel-total">
                  <td className="px-3 py-2">{L.total}</td>
                  {cells(data.total).map((v, i) => (
                    <td key={i} className="px-3 py-2 text-right tabular-nums" data-testid={`affiliate-funnel-total-${COLUMNS[i + 1].key}`}>
                      {v}
                    </td>
                  ))}
                  <td className="px-3 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-3 py-2 text-sm dark:border-gray-800">
              <Button type="button" size="sm" variant="secondary" disabled={query.page <= 1} onClick={() => go({ page: query.page - 1 })}>
                {L.prev}
              </Button>
              <span className="text-gray-600 dark:text-gray-400">{interpolate(L.pageOf, { page: String(query.page), pages: String(pages) })}</span>
              <Button type="button" size="sm" variant="secondary" disabled={query.page >= pages} onClick={() => go({ page: query.page + 1 })}>
                {L.next}
              </Button>
            </div>
          )}
        </Card>
      )}
      <p className="text-xs text-gray-500">
        {data?.switchAtCustomer ? interpolate(L.thresholdNote, { n: String(data.switchAtCustomer) }) : L.noThresholdNote}
      </p>
    </div>
  );
}
