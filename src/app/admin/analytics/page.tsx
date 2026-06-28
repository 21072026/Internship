'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PIPELINE_STATUSES, pipelineLabel } from '@/lib/pipeline';
import { useT, useLocale } from '@/i18n/client';

interface Analytics {
  funnel: Record<string, number>;
  totalRelations: number;
  conversionToHired: number;
  mentorWorkload: { id: string; fullName: string; active: number; hired: number }[];
  engagement: { interactions: number; meetings: number };
  rsvp: { ACCEPTED?: number; DECLINED?: number; PENDING?: number; acceptanceRate: number };
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/analytics')
      .then((r) => r.json())
      .then((d) => setData(d))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-12 text-gray-400">{t.common.loading}</div>;
  if (!data) return <div className="text-center py-12 text-gray-400">{t.common.notFound}</div>;

  const maxFunnel = Math.max(1, ...PIPELINE_STATUSES.map((s) => data.funnel[s] || 0));

  const exportExcel = async () => {
    const { exportXlsx } = await import('@/lib/excel');
    const rows = PIPELINE_STATUSES.map((s) => [pipelineLabel(s, locale), data.funnel[s] || 0]);
    await exportXlsx(`analytics-${new Date().toISOString().slice(0, 10)}`, ['Stage', 'Count'], rows, 'Funnel');
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t.analytics.title}</h1>
          <p className="text-gray-500 mt-1">{t.analytics.subtitle}</p>
        </div>
        <div className="flex gap-2 no-print">
          <Button variant="outline" size="sm" onClick={exportExcel}>{t.analytics.exportExcel}</Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>{t.analytics.print}</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label={t.analytics.totalRelations} value={data.totalRelations} />
        <Stat label={t.analytics.conversion} value={`${data.conversionToHired}%`} />
        <Stat label={t.analytics.interactions} value={data.engagement.interactions} />
        <Stat label={t.analytics.rsvpRate} value={`${data.rsvp.acceptanceRate}%`} />
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
    </div>
  );
}
