'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Coins } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT, useLocale } from '@/i18n/client';
import { useStageLabel } from '@/lib/pipelineStagesClient';
import { formatMinorAmount } from '@/lib/money';
import type { DealValueMonth, ValueTally } from '@/lib/dealValue';

type Payload =
  | { enabled: false }
  | ({ enabled: true; wonKeys: string[] } & (
      | { ok: true; currency: string; months: DealValueMonth[] }
      | { ok: false; error: string; currencies?: string[] }
    ));

// The ESTIMATED value of won deals, month by month (#2422), on
// /admin/analytics — MARKETING only (GET /api/admin/analytics/deal-value answers
// `enabled: false` for any other vertical, and then nothing is drawn).
//
// Every label says "estimated": pricing is usage-based, so the sums are of the
// estimates reps typed or the import brought in, never of invoices. Amounts go
// through src/lib/money.ts. A range that mixes currencies shows the typed
// refusal instead of a total — nothing is ever converted.
export function DealValueCard({ query }: { query: string }) {
  const t = useT();
  const c = t.dealValue.card;
  const locale = useLocale();
  const label = useStageLabel();
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/analytics/deal-value${query}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [query]);

  if (!data || !data.enabled) return null;

  const stage = data.wonKeys.length > 0 ? label(data.wonKeys[0]) : '—';
  const money = (tally: ValueTally, currency: string) => (
    <>
      <span className="font-medium text-gray-900 dark:text-gray-100">{formatMinorAmount(tally.valueMinor, currency, locale)}</span>
      {tally.unvalued > 0 && (
        <span className="block text-xs text-gray-500 dark:text-gray-400">{c.unvalued.replace('{n}', String(tally.unvalued))}</span>
      )}
    </>
  );

  let body: ReactNode;
  if (!data.ok) {
    body = (
      <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="deal-value-card-error">
        {data.error === 'mixed_currency'
          ? c.mixedCurrency.replace('{currencies}', (data.currencies ?? []).join(', '))
          : c.error}
      </p>
    );
  } else if (data.months.every((m) => m.activeAtEnd.count === 0 && m.won.count === 0 && m.lost.count === 0)) {
    body = <p className="text-sm text-gray-500 dark:text-gray-400" data-testid="deal-value-card-empty">{c.empty}</p>;
  } else {
    const currency = data.currency;
    body = (
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="deal-value-table">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
              <th className="py-2 pr-3">{c.month}</th>
              <th className="py-2 pr-3">{c.won}</th>
              <th className="py-2 pr-3">{c.lost}</th>
              <th className="py-2 pr-3">{c.active}</th>
              <th className="py-2">{c.value}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
            {data.months.map((m) => (
              <tr key={m.month} data-testid={`deal-value-${m.month}`}>
                <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-100">{m.month}</td>
                <td className="py-2 pr-3" data-testid={`deal-value-${m.month}-won`}>
                  {m.won.count} · {money(m.won, currency)}
                </td>
                <td className="py-2 pr-3" data-testid={`deal-value-${m.month}-lost`}>
                  {m.lost.count} · {money(m.lost, currency)}
                </td>
                <td className="py-2 pr-3" data-testid={`deal-value-${m.month}-active`}>{m.activeAtEnd.count}</td>
                <td className="py-2" data-testid={`deal-value-${m.month}-mrr`}>{money(m.activeAtEnd, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <Card className="mb-6" data-testid="deal-value-card">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-blue-600" />
          <CardTitle>{c.title}</CardTitle>
        </div>
      </CardHeader>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{c.hint.replace('{stage}', stage)}</p>
      {body}
    </Card>
  );
}
