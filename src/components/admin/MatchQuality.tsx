'use client';

import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

interface RankRow {
  position: number;
  shown: number;
  accepted: number;
  dismissed: number;
  rate: number | null;
}

interface MatchQualityData {
  months: number;
  batches: number;
  accepted: number;
  acceptanceRate: number | null;
  offList: number;
  shown: number;
  dismissed: number;
  byRank: RankRow[];
  dismissReasons: { reason: string; count: number }[];
  trend: { month: string; batches: number; accepted: number; rate: number | null }[];
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-800 p-3">
      <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
    </div>
  );
}

// Match-quality report (#2040) on the admin analytics page: of the mentor
// suggestions we made, how many were taken, at which position, and why the rest
// were thrown away. Every number here is aggregated by the database — this
// component only formats.
//
// With no suggestions recorded yet the card still renders, saying so in one
// line rather than a grid of "0 / 0 / —": the empty state is how an admin who
// has never pressed the suggest button finds out the number exists at all. It
// stays hidden only while the request is in flight or if it failed.
export function MatchQuality() {
  const t = useT();
  const f = t.matchFeedback;
  const [data, setData] = useState<MatchQualityData | null>(null);

  useEffect(() => {
    fetch('/api/admin/analytics/match-quality')
      .then(async (r) => {
        if (!r.ok) return;
        setData(await r.json());
      })
      .catch((e) => console.error('[analytics/match-quality]', e));
  }, []);

  if (!data) return null;

  const reasonLabel = (code: string) =>
    (f.reasons as Record<string, string>)[code] ?? code;
  const rate = (v: number | null) => (v === null ? f.noData : `${v}%`);
  const maxTrend = Math.max(1, ...data.trend.map((m) => m.batches));

  return (
    <Card className="mt-6" data-testid="match-quality">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-blue-600" />
          <CardTitle>{f.reportTitle}</CardTitle>
        </div>
      </CardHeader>
      <p className="text-xs text-gray-500 -mt-2 mb-4">
        {f.reportSubtitle.replace('{n}', String(data.months))}
      </p>

      {data.batches === 0 ? (
        <p className="text-sm text-gray-400 py-2" data-testid="match-quality-empty">{f.reportEmpty}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Stat label={f.batches} value={data.batches} />
            <Stat label={f.accepted} value={data.accepted} />
            <Stat label={f.acceptanceRate} value={rate(data.acceptanceRate)} />
            <Stat label={f.offList} value={data.offList} />
            <Stat label={f.dismissedCount} value={data.dismissed} />
          </div>

          {/* Does our #1 actually get picked? */}
          {data.byRank.length > 0 && (
            <div className="mt-6">
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1.5">{f.byRankTitle}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="match-quality-by-rank">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                      <th className="py-2 pr-3">{f.position}</th>
                      <th className="py-2 pr-3">{f.shown}</th>
                      <th className="py-2 pr-3">{f.accepted}</th>
                      <th className="py-2 pr-3">{f.dismissedCount}</th>
                      <th className="py-2">{f.rate}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                    {data.byRank.map((r) => (
                      <tr key={r.position}>
                        <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">#{r.position}</td>
                        <td className="py-2 pr-3">{r.shown}</td>
                        <td className="py-2 pr-3">{r.accepted}</td>
                        <td className="py-2 pr-3">{r.dismissed}</td>
                        <td className="py-2">{rate(r.rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {data.dismissReasons.length > 0 && (
            <div className="mt-6">
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1.5">{f.reasonsTitle}</p>
              <div className="divide-y divide-gray-50 dark:divide-gray-800" data-testid="match-quality-reasons">
                {data.dismissReasons.map((r) => (
                  <div key={r.reason} className="flex items-center justify-between py-1.5 text-sm">
                    <span className="text-gray-600 dark:text-gray-300">{reasonLabel(r.reason)}</span>
                    <span className="text-gray-500 flex-shrink-0">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-6">
            <p className="text-sm font-semibold text-gray-800 dark:text-gray-200 mb-1.5">{f.trendTitle}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="match-quality-trend">
                <thead>
                  <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800">
                    <th className="py-2 pr-3">{f.month}</th>
                    <th className="py-2 pr-3">{f.batches}</th>
                    <th className="py-2 pr-3">{f.accepted}</th>
                    <th className="py-2">{f.acceptanceRate}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                  {data.trend.map((m) => (
                    <tr key={m.month}>
                      <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{m.month}</td>
                      <td className="py-2 pr-3">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="inline-block h-1.5 rounded bg-blue-500/60"
                            style={{ width: `${Math.round((m.batches / maxTrend) * 60)}px` }}
                          />
                          {m.batches}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{m.accepted}</td>
                      <td className="py-2">{rate(m.rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Card>
  );
}
