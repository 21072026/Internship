'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { PIPELINE_STATUSES, pipelineLabel } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

interface Analytics {
  funnel: Record<string, number>;
  totalRelations: number;
  conversionToHired: number;
  mentorWorkload: { id: string; fullName: string; active: number; hired: number }[];
  projectWorkload: { name: string; interns: number }[];
  engagement: { interactions: number; meetings: number };
  rsvp: { ACCEPTED?: number; DECLINED?: number; PENDING?: number; responded?: number; acceptanceRate: number | null };
  trends?: { months: string[]; newRelations: number[]; interactions: number[] };
  range?: { from: string; to: string };
}

type RangePreset = '30' | '90' | '6m' | '12m' | 'all';

// Turn a preset into a from/to query string. "All time" sends no bounds so the
// API falls back to its default (which then reports the widest sensible window).
function rangeQuery(preset: RangePreset): string {
  if (preset === 'all') return '';
  const to = new Date();
  const from = new Date(to);
  if (preset === '30') from.setDate(from.getDate() - 30);
  else if (preset === '90') from.setDate(from.getDate() - 90);
  else if (preset === '6m') from.setMonth(from.getMonth() - 6);
  else if (preset === '12m') from.setMonth(from.getMonth() - 12);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return `?from=${iso(from)}&to=${iso(to)}`;
}

interface AgingItem {
  relationId: string;
  menteeId: string;
  menteeName: string;
  pipelineStatus: string;
  daysInStage: number;
  overdue: boolean;
}
interface Aging {
  stageAging: { pipelineStatus: string; count: number; avgDays: number; medianDays: number }[];
  oldestStuck: AgingItem[];
  overdue: AgingItem[];
  overdueCount: number;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-4">
      <p className="text-2xl font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500 mt-1">{label}</p>
    </div>
  );
}

export default function AdminAnalyticsPage() {
  const t = useT();
  const locale = useLocale();
  const [data, setData] = useState<Analytics | null>(null);
  const [aging, setAging] = useState<Aging | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangePreset>('6m');

  useEffect(() => {
    const qs = rangeQuery(range);
    setLoading(true);
    fetch(`/api/admin/analytics${qs}`)
      .then((r) => r.json())
      .then((d) => setData(d))
      .finally(() => setLoading(false));
    fetch(`/api/admin/analytics/aging${qs}`)
      .then((r) => r.json())
      .then((d) => setAging(d))
      .catch(() => {});
  }, [range]);

  const maxFunnel = data ? Math.max(1, ...PIPELINE_STATUSES.map((s) => data.funnel[s] || 0)) : 1;

  const exportExcel = async () => {
    if (!data) return;
    const { exportXlsx } = await import('@/lib/excel');
    const rows = PIPELINE_STATUSES.map((s) => [pipelineLabel(s, locale), data.funnel[s] || 0]);
    await exportXlsx(`analytics-${new Date().toISOString().slice(0, 10)}`, ['Stage', 'Count'], rows, 'Funnel');
  };

  return (
    <div>
      <div className="mb-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t.analytics.title}</h1>
          <p className="text-gray-500 mt-1">{t.analytics.subtitle}</p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <Select
            aria-label={t.analytics.dateRange}
            className="w-auto"
            value={range}
            onChange={(e) => setRange(e.target.value as RangePreset)}
            options={[
              { value: '30', label: t.analytics.last30 },
              { value: '90', label: t.analytics.last90 },
              { value: '6m', label: t.analytics.last6m },
              { value: '12m', label: t.analytics.last12m },
              { value: 'all', label: t.analytics.allTime },
            ]}
          />
          <Button variant="outline" size="sm" onClick={exportExcel} disabled={!data}>{t.analytics.exportExcel}</Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>{t.analytics.print}</Button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-400">{t.common.loading}</div>
      ) : !data ? (
        <div className="text-center py-12 text-gray-400">{t.common.notFound}</div>
      ) : (
        <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label={t.analytics.totalRelations} value={data.totalRelations} />
        <Stat label={t.analytics.conversion} value={`${data.conversionToHired}%`} />
        <Stat label={t.analytics.interactions} value={data.engagement.interactions} />
        <Stat label={t.analytics.rsvpRate} value={data.rsvp.acceptanceRate === null ? '—' : `${data.rsvp.acceptanceRate}%`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>{t.analytics.funnel}</CardTitle></CardHeader>
          <div className="space-y-1.5">
            {PIPELINE_STATUSES.map((s) => {
              const n = data.funnel[s] || 0;
              return (
                <div key={s} className="flex items-center gap-2 text-sm">
                  <span className="w-48 truncate text-gray-600 flex-shrink-0">{pipelineLabel(s, locale)}</span>
                  <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                    <div className="bg-blue-500 h-full" style={{ width: `${(n / maxFunnel) * 100}%` }} />
                  </div>
                  <span className="w-8 text-right text-gray-700 flex-shrink-0">{n}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t.analytics.mentorWorkload}</CardTitle></CardHeader>
          {data.mentorWorkload.length === 0 ? (
            <p className="text-sm text-gray-400">—</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {data.mentorWorkload.map((m) => (
                <div key={m.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate">{m.fullName}</span>
                  <span className="text-gray-500 flex-shrink-0">
                    {m.active} {t.analytics.active} · {m.hired} {t.analytics.hired}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {data.projectWorkload && data.projectWorkload.length > 0 && (
        <Card className="mt-6">
          <CardHeader><CardTitle>{t.analytics.projects}</CardTitle></CardHeader>
          <div className="divide-y divide-gray-50">
            {data.projectWorkload.map((p) => (
              <div key={p.name} className="flex items-center justify-between py-2 text-sm">
                <span className="truncate">{p.name}</span>
                <span className="text-gray-500 flex-shrink-0">{p.interns} {t.analytics.interns}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {data.trends && data.trends.months.length > 0 && (() => {
        const max = Math.max(1, ...data.trends.newRelations, ...data.trends.interactions);
        return (
          <Card className="mt-6">
            <CardHeader><CardTitle>{t.analytics.trends}</CardTitle></CardHeader>
            <div className="flex items-end gap-3 h-44 px-2">
              {data.trends.months.map((m, i) => (
                <div key={m} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <div className="flex items-end gap-1 flex-1 w-full justify-center">
                    <div
                      className="w-3 sm:w-4 bg-blue-500 rounded-t"
                      style={{ height: `${(data.trends!.newRelations[i] / max) * 100}%` }}
                      title={`${t.analytics.trendNewRelations}: ${data.trends!.newRelations[i]}`}
                    />
                    <div
                      className="w-3 sm:w-4 bg-emerald-400 rounded-t"
                      style={{ height: `${(data.trends!.interactions[i] / max) * 100}%` }}
                      title={`${t.analytics.trendInteractions}: ${data.trends!.interactions[i]}`}
                    />
                  </div>
                  <span className="text-[10px] text-gray-400">{m.slice(5)}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-4 mt-4 text-xs text-gray-500">
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-500 inline-block" />{t.analytics.trendNewRelations}</span>
              <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-400 inline-block" />{t.analytics.trendInteractions}</span>
            </div>
          </Card>
        );
      })()}

      {aging && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t.analytics.aging.stageAging}
                {aging.overdueCount > 0 && (
                  <Badge variant="danger" className="flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> {aging.overdueCount} {t.analytics.aging.overdue}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            {aging.stageAging.length === 0 ? (
              <p className="text-sm text-gray-400">—</p>
            ) : (
              <div className="divide-y divide-gray-50 dark:divide-gray-800">
                {aging.stageAging.map((s) => (
                  <div key={s.pipelineStatus} className="flex items-center justify-between py-2 text-sm">
                    <span className="truncate">{pipelineLabel(s.pipelineStatus, locale)}</span>
                    <span className="text-gray-500 flex-shrink-0">
                      {t.analytics.aging.avg} {s.avgDays}{t.analytics.aging.days} · {t.analytics.aging.median} {s.medianDays}{t.analytics.aging.days} · {s.count} {t.analytics.aging.candidates}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader><CardTitle>{t.analytics.aging.oldestStuck}</CardTitle></CardHeader>
            {aging.oldestStuck.length === 0 ? (
              <p className="text-sm text-gray-400">—</p>
            ) : (
              <div className="divide-y divide-gray-50 dark:divide-gray-800">
                {aging.oldestStuck.map((it) => (
                  <Link
                    key={it.relationId}
                    href={`/admin/candidates/${it.menteeId}`}
                    className="flex items-center justify-between gap-2 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800/60 -mx-2 px-2 rounded-lg transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="truncate">{it.menteeName}</p>
                      <p className="text-xs text-gray-400 truncate">{pipelineLabel(it.pipelineStatus, locale)}</p>
                    </div>
                    <span className="flex items-center gap-1.5 flex-shrink-0">
                      {it.overdue && <AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
                      <span className="text-gray-500">{it.daysInStage}{t.analytics.aging.days}</span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
        </>
      )}
    </div>
  );
}
