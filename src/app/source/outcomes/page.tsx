'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { exportXlsx } from '@/lib/excel';

// The SOURCE outcome panel (#1914): the referral partner's own referrals, what
// they became. Every number is computed by GET /api/source/outcomes
// (src/lib/sourceOutcomesRule.ts); this page only renders it.

interface Outcomes {
  window: { from: string; to: string };
  minCohort: number;
  finishedLabel: string;
  referred: number;
  inPipeline: number;
  placed: number;
  conversion: number | null;
  suppressed: boolean;
  programmeConversion: number | null;
  programmeSuppressed: boolean;
  notPickedUp: number;
  stages: { key: string; label: string | null; count: number }[];
  timeToPlacement: { medianDays: number | null; placed: number; considered: number };
  trend: { month: string; referred: number; placed: number }[];
  rows: {
    id: string;
    fullName: string;
    referredAt: string;
    stage: string | null;
    stageLabel: string | null;
    daysSinceReferral: number;
    placed: boolean;
    placedAt: string | null;
  }[];
}

const fill = (template: string, slots: Record<string, string | number>) =>
  Object.entries(slots).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);

function Stat({ label, value, note, testId }: { label: string; value: string | number; note?: string; testId: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid={testId}>{value}</p>
      {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
    </Card>
  );
}

export default function SourceOutcomesPage() {
  const t = useT();
  const s = t.sourceOutcomes;
  const locale = useLocale();
  const [data, setData] = useState<Outcomes | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async (range: { from: string; to: string }) => {
    setLoading(true);
    setError('');
    const qs = new URLSearchParams();
    if (range.from) qs.set('from', range.from);
    if (range.to) qs.set('to', range.to);
    const res = await fetch(`/api/source/outcomes?${qs}`);
    if (res.ok) {
      const body: Outcomes = await res.json();
      setData(body);
      setFrom((f) => f || body.window.from.slice(0, 10));
      setTo((v) => v || body.window.to.slice(0, 10));
    } else {
      setData(null);
      setError(res.status === 403 ? s.noSource : t.common.error);
    }
    setLoading(false);
  }, [s.noSource, t.common.error]);
  useEffect(() => { load({ from: '', to: '' }); }, [load]);

  const exportRows = () => {
    if (!data) return;
    exportXlsx(
      `referral-outcomes-${data.window.from.slice(0, 10)}-${data.window.to.slice(0, 10)}`,
      [s.name, s.referredAt, s.stage, s.daysSince, s.placed, s.placedAt],
      data.rows.map((r) => [
        r.fullName,
        r.referredAt.slice(0, 10),
        r.stageLabel ?? s.notPickedUp,
        r.daysSinceReferral,
        r.placed ? s.yes : s.no,
        r.placedAt ? r.placedAt.slice(0, 10) : '',
      ]),
      s.rows,
    );
  };

  const maxStage = Math.max(1, data?.notPickedUp ?? 0, ...(data?.stages.map((x) => x.count) ?? []));
  const maxTrend = Math.max(1, ...(data?.trend.map((x) => x.referred) ?? []));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{s.title}</h1>
        <p className="text-gray-500 mt-1">{s.subtitle}</p>
      </div>

      <form
        className="mb-6 flex flex-wrap items-end gap-3"
        onSubmit={(e) => { e.preventDefault(); load({ from, to }); }}
      >
        <Input label={s.from} type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="outcomes-from" />
        <Input label={s.to} type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="outcomes-to" />
        <Button type="submit" variant="secondary">{s.apply}</Button>
        <Button type="button" onClick={exportRows} disabled={!data || data.rows.length === 0} data-testid="outcomes-export">
          <Download className="h-4 w-4 mr-1" />{s.export}
        </Button>
      </form>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm" data-testid="outcomes-error">{error}</div>}

      {loading && !data ? (
        <SkeletonRows rows={6} />
      ) : data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label={s.referred} value={data.referred} testId="outcomes-referred" />
            <Stat label={s.inPipeline} value={data.inPipeline} testId="outcomes-in-pipeline" />
            <Stat label={s.placed} value={data.placed} testId="outcomes-placed" />
            <Stat
              label={s.conversion}
              value={data.conversion === null ? '—' : `${data.conversion}%`}
              note={
                data.suppressed
                  ? fill(s.suppressed, { n: data.minCohort })
                  : data.programmeSuppressed || data.programmeConversion === null
                    ? s.programmeSuppressed
                    : fill(s.programme, { rate: data.programmeConversion })
              }
              testId="outcomes-conversion"
            />
          </div>
          <p className="text-xs text-gray-500">{fill(s.placedNote, { label: data.finishedLabel })}</p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle>{s.medianTime}</CardTitle></CardHeader>
              {data.timeToPlacement.medianDays === null ? (
                <p className="text-sm text-gray-500" data-testid="outcomes-median">{s.noMedian}</p>
              ) : (
                <>
                  <p className="text-3xl font-bold text-gray-900 dark:text-gray-100" data-testid="outcomes-median">
                    {fill(s.days, { n: data.timeToPlacement.medianDays })}
                  </p>
                  <p className="mt-1 text-xs text-gray-500">{fill(s.medianNote, { placed: data.timeToPlacement.placed })}</p>
                </>
              )}
            </Card>

            <Card>
              <CardHeader><CardTitle>{s.stages}</CardTitle></CardHeader>
              <ul className="space-y-2" data-testid="outcomes-stages">
                {data.notPickedUp > 0 && (
                  <li className="text-sm">
                    <div className="flex justify-between"><span>{s.notPickedUp}</span><span>{data.notPickedUp}</span></div>
                    <div className="h-2 rounded bg-gray-100 dark:bg-gray-700"><div className="h-2 rounded bg-gray-400" style={{ width: `${(data.notPickedUp / maxStage) * 100}%` }} /></div>
                  </li>
                )}
                {data.stages.map((st) => (
                  <li key={st.key} className="text-sm" data-testid={`outcomes-stage-${st.key}`}>
                    <div className="flex justify-between"><span>{st.label}</span><span>{st.count}</span></div>
                    <div className="h-2 rounded bg-gray-100 dark:bg-gray-700"><div className="h-2 rounded bg-blue-500" style={{ width: `${(st.count / maxStage) * 100}%` }} /></div>
                  </li>
                ))}
                {data.referred === 0 && <li className="text-sm text-gray-500">{s.empty}</li>}
              </ul>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle>{s.trend}</CardTitle></CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="outcomes-trend">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1 pr-3 font-medium">{s.month}</th>
                    <th className="py-1 pr-3 font-medium">{s.referred}</th>
                    <th className="py-1 pr-3 font-medium">{s.placed}</th>
                    <th className="py-1 w-1/2" />
                  </tr>
                </thead>
                <tbody>
                  {data.trend.map((m) => (
                    <tr key={m.month} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="py-1 pr-3 whitespace-nowrap">{formatDate(`${m.month}-01T00:00:00Z`, locale, { day: undefined, month: 'short', timeZone: 'UTC' })}</td>
                      <td className="py-1 pr-3">{m.referred}</td>
                      <td className="py-1 pr-3">{m.placed}</td>
                      <td className="py-1">
                        <div className="h-2 rounded bg-gray-100 dark:bg-gray-700"><div className="h-2 rounded bg-blue-500" style={{ width: `${(m.referred / maxTrend) * 100}%` }} /></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader><CardTitle>{s.rows} ({data.rows.length})</CardTitle></CardHeader>
            {data.rows.length === 0 ? (
              <p className="text-center py-8 text-gray-400">{s.empty}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="outcomes-rows">
                  <thead>
                    <tr className="text-left text-gray-500">
                      <th className="py-2 pr-3 font-medium">{s.name}</th>
                      <th className="py-2 pr-3 font-medium">{s.referredAt}</th>
                      <th className="py-2 pr-3 font-medium">{s.stage}</th>
                      <th className="py-2 pr-3 font-medium">{s.daysSince}</th>
                      <th className="py-2 pr-3 font-medium">{s.placed}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} className="border-t border-gray-100 dark:border-gray-800" data-testid={`outcomes-row-${r.id}`}>
                        <td className="py-2 pr-3 text-gray-900 dark:text-gray-100">{r.fullName}</td>
                        <td className="py-2 pr-3">{formatDate(r.referredAt, locale)}</td>
                        <td className="py-2 pr-3">{r.stageLabel ?? s.notPickedUp}</td>
                        <td className="py-2 pr-3">{r.daysSinceReferral}</td>
                        <td className="py-2 pr-3">{r.placedAt ? formatDate(r.placedAt, locale) : s.no}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
