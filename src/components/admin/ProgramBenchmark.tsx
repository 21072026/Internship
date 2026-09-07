'use client';

import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';

interface Benchmark {
  you: { conversion: number; dropRate: number; total: number; hired: number } | null;
  platform: { avgConversion: number | null; avgDropRate: number | null; poolSize: number; minRelations: number };
  percentile: number | null;
}

// Premium cross-program benchmark (Faz 2, #542) on the admin analytics page.
// Compares your program's funnel conversion against an anonymized platform
// average. Only aggregate numbers are ever shown — no other program is
// identifiable.
//
// Mounted only when the tenant holds the premium analytics tier; the locked
// state is the page-level PremiumAnalyticsLocked panel, so this component no
// longer discovers the gate by reading a 403 of its own (#1442).
export function ProgramBenchmark() {
  const t = useT();
  const c = t.analytics;
  const [data, setData] = useState<Benchmark | null>(null);

  useEffect(() => {
    fetch('/api/admin/analytics/benchmark')
      .then(async (r) => {
        if (r.ok) setData(await r.json());
      })
      .catch(() => {});
  }, []);

  if (!data) return null;

  const you = data.you;
  const p = data.platform;

  const Metric = ({ label, you: y, avg }: { label: string; you: number | null; avg: number | null }) => {
    const delta = y != null && avg != null ? y - avg : null;
    return (
      <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
        <div className="flex items-baseline gap-2 mt-1">
          <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">{y != null ? `${y}%` : '—'}</span>
          <span className="text-xs text-gray-400">{c.benchmarkVsAvg} {avg != null ? `${avg}%` : '—'}</span>
        </div>
        {delta != null && (
          <p className={`text-xs mt-1 ${delta >= 0 ? 'text-green-600' : 'text-amber-600'}`}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)} {c.benchmarkPoints}
          </p>
        )}
      </div>
    );
  };

  return (
    <Card className="mt-6" data-testid="benchmark">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-blue-600" />
          <CardTitle>{c.benchmarkTitle}</CardTitle>
        </div>
      </CardHeader>
      {!you ? (
        <p className="text-sm text-gray-400 py-4">{c.benchmarkNoData}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Metric label={c.benchmarkConversion} you={you.conversion} avg={p.avgConversion} />
            <Metric label={c.benchmarkDropRate} you={you.dropRate} avg={p.avgDropRate} />
          </div>
          <p className="text-xs text-gray-400 mt-3">
            {c.benchmarkPool.replace('{n}', String(p.poolSize))}
            {data.percentile != null ? ` · ${c.benchmarkPercentile.replace('{p}', String(data.percentile))}` : ''}
          </p>
          <p className="text-xs text-gray-400 mt-1">{c.benchmarkAnonNote}</p>
        </>
      )}
    </Card>
  );
}
