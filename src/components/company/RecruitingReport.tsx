'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Download, Printer } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/client';
import { exportXlsxSheets } from '@/lib/excel';

// The employer's recruiting report (#1911): funnel, time-to-hire, time-to-fill,
// source and trend for a date window and optionally one role, all from
// GET /api/company/analytics; the benchmark from its own gated route. Export
// renders the same payload the screen shows (one source, src/lib/recruitingAnalytics.ts);
// print uses the browser's print with the controls hidden.

type Stage = { key: string; entered: number; advanced: number; rate: number | null; terminal: boolean };
type Recruiting = {
  window: { from: string; to: string };
  applications: number;
  funnel: { stages: Stage[]; timeToHire: { completed: number; considered: number; medianDays: number | null } };
  timeToFill: { filled: number; considered: number; medianDays: number | null };
  sources: { source: string; applications: number; hired: number; conversion: number | null }[];
  trend: { month: string; applications: number; advances: number; hires: number }[];
};
type Benchmark = { you: { conversion: number } | null; avgConversion: number | null; percentile: number | null; available: boolean };

const day = (iso: string) => iso.slice(0, 10);

export function RecruitingReport() {
  const t = useT();
  const R = t.companyAnalytics.recruiting;
  const [data, setData] = useState<Recruiting | null>(null);
  const [canExport, setCanExport] = useState(false);
  const [benchmark, setBenchmark] = useState<Benchmark | 'locked' | null>(null);
  const [roles, setRoles] = useState<{ id: string; title: string }[]>([]);
  const [draft, setDraft] = useState({ from: '', to: '', requisitionId: '' });
  const [applied, setApplied] = useState(draft);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
    try {
      const res = await fetch(`/api/company/analytics?${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setData(body.recruiting);
      setCanExport(Boolean(body.canExport));
      setFailed(false);
      if (!draft.from && body.recruiting) setDraft((d) => ({ ...d, from: day(body.recruiting.window.from), to: day(body.recruiting.window.to) }));
    } catch {
      setFailed(true);
    }
    const bq = new URLSearchParams(Object.entries({ from: applied.from, to: applied.to }).filter(([, v]) => v)).toString();
    const b = await fetch(`/api/company/analytics/benchmark?${bq}`).catch(() => null);
    if (b?.status === 403) setBenchmark('locked');
    else if (b?.ok) setBenchmark(await b.json());
    else setBenchmark(null);
    // draft is only seeded once from the server's default window
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    fetch('/api/requisitions?pageSize=100')
      .then((r) => (r.ok ? r.json() : { requisitions: [] }))
      .then((body) => setRoles((body.requisitions ?? []).map((q: { id: string; title: string }) => ({ id: q.id, title: q.title }))))
      .catch(() => {});
  }, []);

  const submit = (e: FormEvent) => { e.preventDefault(); setApplied(draft); };
  const days = (n: number | null) => (n === null ? R.none : R.days.replace('{n}', String(n)));
  const pct = (n: number | null) => (n === null ? R.none : `${n} %`);

  const exportWorkbook = async () => {
    if (!data) return;
    await exportXlsxSheets(`recruiting-${day(data.window.from)}-${day(data.window.to)}`, [
      { name: R.funnelTitle, columns: [R.colStage, R.colEntered, R.colAdvanced, R.colRate], rows: data.funnel.stages.map((s) => [R.stages[s.key as keyof typeof R.stages] ?? s.key, s.entered, s.advanced, s.rate]) },
      { name: R.sourcesTitle, columns: [R.colSource, R.colApplications, R.colHired, R.colConversion], rows: data.sources.map((s) => [R.sources[s.source as keyof typeof R.sources] ?? s.source, s.applications, s.hired, s.conversion]) },
      { name: R.trendTitle, columns: [R.colMonth, R.trendApplications, R.trendAdvances, R.trendHires], rows: data.trend.map((m) => [m.month, m.applications, m.advances, m.hires]) },
      { name: R.timeToFill, columns: [R.timeToHire, R.timeToFill], rows: [[data.funnel.timeToHire.medianDays, data.timeToFill.medianDays]] },
    ]);
  };

  const maxTrend = data ? Math.max(1, ...data.trend.map((m) => m.applications)) : 1;

  return (
    <section className="mb-8 space-y-6" data-testid="recruiting-report">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{R.title}</h2>
        <div className="flex gap-2 print:hidden">
          {canExport && <Button variant="outline" size="sm" onClick={() => void exportWorkbook()} data-testid="recruiting-export"><Download className="mr-1 h-4 w-4" aria-hidden="true" />{R.exportXlsx}</Button>}
          <Button variant="outline" size="sm" onClick={() => window.print()} data-testid="recruiting-print"><Printer className="mr-1 h-4 w-4" aria-hidden="true" />{R.print}</Button>
        </div>
      </div>

      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-4 print:hidden" data-testid="recruiting-filters">
        <Input type="date" label={R.from} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} data-testid="recruiting-from" />
        <Input type="date" label={R.to} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} data-testid="recruiting-to" />
        <Select label={R.requisition} value={draft.requisitionId} onChange={(e) => setDraft({ ...draft, requisitionId: e.target.value })}
          options={[{ value: '', label: R.allRequisitions }, ...roles.map((q) => ({ value: q.id, label: q.title }))]} data-testid="recruiting-requisition" />
        <div className="flex items-end"><Button type="submit" data-testid="recruiting-apply">{R.apply}</Button></div>
      </form>

      {failed && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{t.common.error}</p>}
      {data && (
        <>
          <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="recruiting-applications">{R.applications.replace('{n}', String(data.applications))}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{R.timeToHire}</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="recruiting-time-to-hire">{days(data.funnel.timeToHire.medianDays)}</p>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{R.timeToHireHint.replace('{completed}', String(data.funnel.timeToHire.completed)).replace('{considered}', String(data.funnel.timeToHire.considered))}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{R.timeToFill}</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="recruiting-time-to-fill">{days(data.timeToFill.medianDays)}</p>
              <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{R.timeToFillHint.replace('{filled}', String(data.timeToFill.filled)).replace('{considered}', String(data.timeToFill.considered))}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <Card>
              <CardHeader><CardTitle>{R.funnelTitle}</CardTitle></CardHeader>
              <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">{R.defConversion}</p>
              {data.applications === 0 ? (
                <p className="text-sm text-gray-600 dark:text-gray-400">{R.noApplications}</p>
              ) : (
                <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="recruiting-funnel">
                  <thead><tr className="text-left text-gray-600 dark:text-gray-400"><th className="py-1">{R.colStage}</th><th>{R.colEntered}</th><th>{R.colAdvanced}</th><th>{R.colRate}</th></tr></thead>
                  <tbody>
                    {data.funnel.stages.map((s) => (
                      <tr key={s.key} className="border-t border-gray-100 dark:border-gray-800" data-testid={`recruiting-stage-${s.key}`}>
                        <td className="py-1 text-gray-900 dark:text-gray-100">{R.stages[s.key as keyof typeof R.stages] ?? s.key}</td>
                        <td>{s.entered}</td><td>{s.advanced}</td><td>{pct(s.rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </Card>

            <Card>
              <CardHeader><CardTitle>{R.sourcesTitle}</CardTitle></CardHeader>
              <div className="overflow-x-auto"><table className="w-full text-sm" data-testid="recruiting-sources">
                <thead><tr className="text-left text-gray-600 dark:text-gray-400"><th className="py-1">{R.colSource}</th><th>{R.colApplications}</th><th>{R.colHired}</th><th>{R.colConversion}</th></tr></thead>
                <tbody>
                  {data.sources.map((s) => (
                    <tr key={s.source} className="border-t border-gray-100 dark:border-gray-800" data-testid={`recruiting-source-${s.source}`}>
                      <td className="py-1 text-gray-900 dark:text-gray-100">{R.sources[s.source as keyof typeof R.sources] ?? s.source}</td>
                      <td>{s.applications}</td><td>{s.hired}</td><td>{pct(s.conversion)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>{R.trendTitle}</CardTitle></CardHeader>
            <ul className="space-y-2" data-testid="recruiting-trend">
              {data.trend.map((m) => (
                <li key={m.month} className="grid grid-cols-[5rem_1fr] items-center gap-3 text-sm" data-testid={`recruiting-month-${m.month}`}>
                  <span className="text-gray-700 dark:text-gray-300">{m.month}</span>
                  <div>
                    <div className="h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"><div className="h-full bg-blue-600" style={{ width: `${Math.round((m.applications / maxTrend) * 100)}%` }} /></div>
                    <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">{R.trendApplications}: {m.applications} · {R.trendAdvances}: {m.advances} · {R.trendHires}: {m.hires}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card data-testid="recruiting-benchmark">
            <CardHeader><CardTitle>{R.benchmarkTitle}</CardTitle></CardHeader>
            {benchmark === 'locked' ? (
              <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="recruiting-benchmark-locked">{R.benchmarkLocked}</p>
            ) : !benchmark ? null : !benchmark.available ? (
              <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="recruiting-benchmark-unavailable">{R.benchmarkUnavailable}</p>
            ) : (
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-gray-600 dark:text-gray-400">{R.benchmarkYou}</dt><dd className="text-xl font-bold text-gray-900 dark:text-gray-100">{pct(benchmark.you?.conversion ?? null)}</dd></div>
                <div><dt className="text-gray-600 dark:text-gray-400">{R.benchmarkAverage}</dt><dd className="text-xl font-bold text-gray-900 dark:text-gray-100">{pct(benchmark.avgConversion)}</dd></div>
                {benchmark.percentile !== null && <p className="col-span-2 text-gray-700 dark:text-gray-300">{R.benchmarkPercentile.replace('{p}', String(benchmark.percentile))}</p>}
              </dl>
            )}
          </Card>
        </>
      )}
    </section>
  );
}
