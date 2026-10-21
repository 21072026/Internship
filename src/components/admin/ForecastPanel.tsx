'use client';

import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import { fillTemplate } from '@/components/ui/fillTemplate';
import type { CapacityRequirement, Placements } from '@/lib/forecast';

// The forecast and capacity panel on the executive dashboard (#1897): the
// sentence a sponsor renews on, the stage where mentor capacity runs out, and
// the multiplication behind both. Every word here says "at your current
// conversion rate"; none of it may call the figure a prediction.

interface ForecastResponse {
  horizon: string;
  historyDays: number;
  stages: { key: string; label: string }[];
  finishedKey: string;
  finishedLabel: string;
  placements: Placements;
  capacity: CapacityRequirement | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const sixMonthsOut = () => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 6);
  return isoDay(d);
};

export function ForecastPanel() {
  const t = useT();
  const locale = useLocale();
  const f = t.executive.forecast;
  const fc = t.forecastCapacity;
  const [horizon, setHorizon] = useState(sixMonthsOut);
  const [data, setData] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    fetch(`/api/admin/analytics/forecast?horizon=${horizon}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => live && setData(d))
      .catch(() => live && setError(t.common.error));
    return () => {
      live = false;
    };
  }, [horizon, t.common.error]);

  const label = (key: string) => data?.stages.find((s) => s.key === key)?.label ?? key;
  // A calendar day, not an instant: formatted in UTC so it never shifts a day.
  const date = data
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${data.horizon}T00:00:00Z`))
    : '';
  const p = data?.placements;
  const c = data?.capacity;
  const loadOf = (key: string) => c?.byStage.find((s) => s.key === key)?.requiredDays;

  return (
    <section className="mt-6 rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 break-inside-avoid" data-testid="executive-forecast">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-semibold text-gray-900 dark:text-gray-100">{f.title}</h2>
        <label className="no-print text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1">{f.horizon}</span>
          <input
            type="date"
            value={horizon}
            min={isoDay(new Date(Date.now() + 24 * 60 * 60 * 1000))}
            onChange={(ev) => ev.target.value && setHorizon(ev.target.value)}
            data-testid="executive-forecast-horizon"
            className="block rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
          />
        </label>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {data && p && (
        <>
          {p.status === 'insufficient' && (
            <p className="mt-3 text-sm text-gray-700 dark:text-gray-300" data-testid="executive-forecast-insufficient">
              {fillTemplate(f.insufficient, {
                floor: p.minJourneys,
                stages: p.belowFloor.map((s) => `${label(s.key)} (${s.entered})`).join(', '),
              })}
            </p>
          )}
          {p.status === 'no_population' && (
            <p className="mt-3 text-sm text-gray-700 dark:text-gray-300" data-testid="executive-forecast-empty">
              {fillTemplate(f.noPopulation, { stage: label(data.finishedKey) })}
            </p>
          )}
          {p.status === 'ok' && (
            <>
              <p className="mt-3 text-lg text-gray-900 dark:text-gray-100" data-testid="executive-forecast-sentence">
                {fillTemplate(f.sentence, {
                  expected: Math.round(p.expected),
                  population: p.population,
                  stage: label(data.finishedKey),
                  date,
                  low: Math.round(p.low),
                  high: Math.round(p.high),
                })}
              </p>
              {c && (
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300" data-testid="executive-forecast-capacity">
                  {c.status === 'unknown'
                    ? fc.capacityUnknown
                    : c.bottleneck
                      ? fillTemplate(fc.bottleneck, { stage: label(c.bottleneck), n: c.additionalMentors, date })
                      : fillTemplate(fc.noBottleneck, { date })}
                </p>
              )}
              <details className="mt-3 text-xs text-gray-600 dark:text-gray-400">
                <summary className="inline-flex cursor-pointer items-center gap-1 text-blue-600" data-testid="executive-forecast-how">
                  <Info className="h-3.5 w-3.5" /> {f.showWorking}
                </summary>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left" data-testid="executive-forecast-working">
                    <thead className="text-gray-500 border-b border-gray-200 dark:border-gray-700">
                      <tr>
                        <th className="py-1 pr-3">{f.colStage}</th>
                        <th className="py-1 pr-3 text-right">{f.colToday}</th>
                        <th className="py-1 pr-3 text-right">{f.colRate}</th>
                        <th className="py-1 pr-3 text-right">{f.colDwell}</th>
                        <th className="py-1 pr-3 text-right">{f.colToFinish}</th>
                        <th className="py-1 pr-3 text-right">{f.colExpected}</th>
                        {c?.status === 'ok' && <th className="py-1 text-right">{fc.colLoad}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {p.steps.map((s) => {
                        const row = p.byStage.find((b) => b.key === s.key);
                        return (
                          <tr key={s.key} className="border-b border-gray-100 dark:border-gray-800 last:border-0" data-testid={`executive-forecast-row-${s.key}`}>
                            <td className="py-1 pr-3">{label(s.key)}</td>
                            <td className="py-1 pr-3 text-right">{row?.count ?? 0}</td>
                            <td className="py-1 pr-3 text-right">{fillTemplate(f.rateCell, { advanced: s.advanced, entered: s.entered })}</td>
                            <td className="py-1 pr-3 text-right">{s.medianDwellDays ?? '—'}</td>
                            <td className="py-1 pr-3 text-right">{row ? (row.dwellToFinishDays ?? '—') : ''}</td>
                            <td className="py-1 pr-3 text-right">{row ? (row.fits ? `${row.count} × ${row.remainingConversion.toFixed(3)} = ${row.expected}` : f.notInHorizon) : ''}</td>
                            {c?.status === 'ok' && <td className="py-1 text-right">{loadOf(s.key) ?? 0}</td>}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {c?.status === 'ok' && (
                  <p className="mt-2" data-testid="executive-forecast-capacity-line">
                    {fillTemplate(fc.capacityLine, { required: c.requiredDays, available: c.availableDays, seats: c.load.seats, days: c.horizonDays })}
                  </p>
                )}
                <p className="mt-2">{f.band}</p>
              </details>
            </>
          )}
          <p className="mt-3 text-xs text-gray-500">{f.method}</p>
        </>
      )}
    </section>
  );
}
