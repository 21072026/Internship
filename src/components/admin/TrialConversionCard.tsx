'use client';

import { Info } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';
import { useStageLabel } from '@/lib/pipelineStagesClient';

// Trial → paid conversion on /admin/analytics (#2556).
//
// Rendered only when the funnel route returned a `trialConversion` block, and
// the route returns one only for a tenant whose OWN stage set has a trial
// stage — so an INTERNSHIP org, or a MARKETING org that removed the stage,
// never sees an empty card about trials it does not run. The numbers are
// computed in src/lib/funnelKpi.ts (`trialConversion`); this only draws them.
//
// Every null renders as an em dash, never 0%: a month whose trials are still
// running has not had its chance to convert, and a 0% there is a claim.

export interface TrialConversionData {
  trialKey: string;
  paidKey: string;
  trialDays: number;
  months: { month: string; started: number; paid: number; rate: number | null; mature: boolean }[];
  bySource: { sourceId: string | null; name: string | null; trials: number; paid: number; rate: number | null }[] | null;
}

const th = 'py-1.5 pr-3';
const pct = (rate: number | null) => (rate === null ? '—' : `${rate}%`);

export function TrialConversionCard({ data }: { data: TrialConversionData }) {
  const t = useT();
  const label = useStageLabel();
  const k = t.analytics.trialKpi;

  return (
    <Card className="mb-6" data-testid="trial-kpi-card">
      <CardHeader><CardTitle>{k.title}</CardTitle></CardHeader>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <p className="text-xs text-gray-500 mb-3">
            {k.hint.replace('{trial}', label(data.trialKey)).replace('{paid}', label(data.paidKey))}
          </p>
          {data.months.length === 0 || data.months.every((m) => m.started === 0) ? (
            <p className="text-sm text-gray-500" data-testid="trial-kpi-empty">{k.empty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="trial-kpi-table">
                <thead className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    <th className={`${th} text-left`}>{k.month}</th>
                    <th className={`${th} text-right`}>{k.started}</th>
                    <th className={`${th} text-right`}>{k.paid}</th>
                    <th className="py-1.5 text-right">{k.rate}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((m) => (
                    <tr key={m.month} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-400">{m.month}</td>
                      <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">{m.started}</td>
                      <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">{m.paid}</td>
                      <td
                        className="py-1.5 text-right font-medium text-gray-900 dark:text-gray-100"
                        data-testid={`trial-kpi-${m.month}`}
                        data-mature={m.mature ? 'true' : 'false'}
                      >
                        {pct(m.rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{k.bySource}</p>
          <p className="text-xs text-gray-500 mt-0.5 mb-3">{k.bySourceHint}</p>
          {data.bySource === null ? (
            <p className="text-sm text-gray-500" data-testid="trial-source-locked">{k.sourceLocked}</p>
          ) : data.bySource.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="trial-source-empty">{k.sourceEmpty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="trial-source-table">
                <thead className="text-xs text-gray-500 border-b border-gray-200 dark:border-gray-700">
                  <tr>
                    <th className={`${th} text-left`}>{k.source}</th>
                    <th className={`${th} text-right`}>{k.started}</th>
                    <th className={`${th} text-right`}>{k.paid}</th>
                    <th className="py-1.5 text-right">{k.rate}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bySource.map((s) => (
                    <tr key={s.sourceId ?? '__none'} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                      <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-400">{s.name ?? k.noSource}</td>
                      <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">{s.trials}</td>
                      <td className="py-1.5 pr-3 text-right text-gray-700 dark:text-gray-300">{s.paid}</td>
                      <td
                        className="py-1.5 text-right font-medium text-gray-900 dark:text-gray-100"
                        data-testid={`trial-source-${s.sourceId ?? 'none'}`}
                      >
                        {pct(s.rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-xs text-gray-400" data-testid="trial-kpi-history-note">
        <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
        {k.historyNote}
      </p>
    </Card>
  );
}
