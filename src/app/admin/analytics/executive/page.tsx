'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Info, Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { PremiumAnalyticsLocked } from '@/components/admin/PremiumAnalyticsLocked';
import { useT } from '@/i18n/client';
import { useAdvancedAnalytics } from '@/lib/analyticsEntitlementsClient';
import { deltaOf, expressionOf, type Period, type ScorePoint } from '@/lib/executiveScores';

// The executive dashboard (#1895): four named 0–100 scores a sponsor
// screenshots into a renewal deck. Each is 100 × a count ÷ a count over the
// customer's own records (src/lib/executiveScores.ts); the info affordance
// shows the counts, and nothing is labelled a prediction. Capability stays an
// explicit "not yet measurable" until #1822/#1823 give it something real to
// read. Prints to one A4 page (globals.css, #executive-print).

const DOC_URL = 'https://github.com/21072026/Internship/blob/main/docs/executive-dashboard.md';

interface ExecutiveResponse {
  window: Period;
  cohortId: string | null;
  cohorts: { id: string; name: string }[];
  periods: Period[];
  engagement: ScorePoint[];
  progression: ScorePoint[];
  placement: ScorePoint[];
  finishedLabel: string;
  capability: { measurable: false; dependsOn: number[] };
}

type Measured = 'engagement' | 'progression' | 'placement';
const MEASURED: Measured[] = ['engagement', 'progression', 'placement'];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function ExecutiveDashboardPage() {
  const t = useT();
  const e = t.executive;
  const premium = useAdvancedAnalytics();
  const [data, setData] = useState<ExecutiveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)));
  const [cohortId, setCohortId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ from, to });
    if (cohortId) params.set('cohortId', cohortId);
    try {
      const res = await fetch(`/api/admin/analytics/executive?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
    } catch {
      setError(t.common.error);
    } finally {
      setLoading(false);
    }
  }, [from, to, cohortId, t.common.error]);

  useEffect(() => {
    if (premium === true) load();
  }, [premium, load]);

  if (premium === null) return <p className="text-center py-12 text-gray-400" data-testid="page-loading">{t.common.loading}</p>;
  if (premium === false) {
    return (
      <div className="max-w-xl" data-testid="executive-locked">
        <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline mb-4">
          <ArrowLeft className="h-4 w-4" /> {e.back}
        </Link>
        <PremiumAnalyticsLocked title={e.title} />
      </div>
    );
  }

  const deltaLine = (key: Measured, points: ScorePoint[]) => {
    const d = deltaOf(points);
    const name = e.scores[key].name;
    if (d === null) return e.delta.none;
    if (d === 0) return e.delta.same.replace('{name}', name);
    return (d > 0 ? e.delta.up : e.delta.down).replace('{name}', name).replace('{d}', String(Math.abs(d)));
  };
  const formula = (key: Measured) => e.scores[key].formula.replace('{stage}', data?.finishedLabel ?? '');

  return (
    <div id="executive-print" className="max-w-5xl">
      <div className="no-print mb-4">
        <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
          <ArrowLeft className="h-4 w-4" /> {e.back}
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{e.title}</h1>
          <p className="text-gray-500 mt-1">{e.subtitle}</p>
          {data && <p className="text-xs text-gray-400 mt-1" data-testid="executive-window">{data.window.from} – {data.window.to}</p>}
        </div>
        <Button variant="outline" size="sm" className="no-print" onClick={() => window.print()} data-testid="executive-print-button">
          <Printer className="mr-1 h-4 w-4" /> {e.print}
        </Button>
      </div>

      <div className="no-print grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <label className="text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1.5">{e.from}</span>
          <input type="date" value={from} max={to} onChange={(ev) => ev.target.value && setFrom(ev.target.value)} data-testid="executive-from" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1.5">{e.to}</span>
          <input type="date" value={to} min={from} onChange={(ev) => ev.target.value && setTo(ev.target.value)} data-testid="executive-to" className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        </label>
        <Select
          label={e.cohort}
          data-testid="executive-cohort"
          value={cohortId}
          onChange={(ev) => setCohortId(ev.target.value)}
          options={[{ value: '', label: e.allCohorts }, ...(data?.cohorts ?? []).map((c) => ({ value: c.id, label: c.name }))]}
        />
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      {loading && !data && <p className="text-center py-12 text-gray-400" data-testid="page-loading">{t.common.loading}</p>}

      {data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {MEASURED.map((key) => {
              const points = data[key];
              const current = points.at(-1)!;
              return (
                <section key={key} className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 break-inside-avoid" data-testid={`executive-${key}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold text-gray-900 dark:text-gray-100">{e.scores[key].name}</h2>
                      <p className="text-4xl font-bold text-gray-900 dark:text-gray-100 mt-1" data-testid={`executive-${key}-score`}>
                        {current.score ?? '—'}
                      </p>
                    </div>
                    {/* The CSS bars the product already uses — one per period, no chart library. */}
                    <div className="flex items-end gap-1 h-12 w-28" aria-label={e.trend} data-testid={`executive-${key}-trend`}>
                      {points.map((p, i) => (
                        <div
                          key={p.period.from}
                          title={`${p.period.from} – ${p.period.to}: ${p.score ?? '—'}`}
                          className={`flex-1 rounded-sm ${i === points.length - 1 ? 'bg-blue-600' : 'bg-blue-200 dark:bg-blue-900'}`}
                          style={{ height: `${Math.max(p.score ?? 0, 3)}%` }}
                        />
                      ))}
                    </div>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-2" data-testid={`executive-${key}-delta`}>
                    {current.denominator === 0 ? e.noData : deltaLine(key, points)}
                  </p>
                  <details className="mt-2 text-xs text-gray-500">
                    <summary className="inline-flex cursor-pointer items-center gap-1 text-blue-600" data-testid={`executive-${key}-how`}>
                      <Info className="h-3.5 w-3.5" /> {e.howComputed}
                    </summary>
                    <p className="mt-1">{formula(key)}</p>
                    <p className="mt-1 font-mono" data-testid={`executive-${key}-expression`}>{expressionOf(current)}</p>
                  </details>
                </section>
              );
            })}
            <section className="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 break-inside-avoid" data-testid="executive-capability">
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">{e.scores.capability.name}</h2>
              <p className="text-lg font-semibold text-gray-400 mt-1" data-testid="executive-capability-state">{e.scores.capability.notMeasurable}</p>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">{e.scores.capability.notMeasurableBody}</p>
              <p className="text-xs text-gray-500 mt-1">{e.scores.capability.formula}</p>
              <a href={`${DOC_URL}#capability`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-blue-600 hover:underline">
                {e.scores.capability.link}
              </a>
            </section>
          </div>
          <p className="mt-4 text-xs text-gray-500" data-testid="executive-deterministic">{e.deterministic}</p>
        </>
      )}
    </div>
  );
}
