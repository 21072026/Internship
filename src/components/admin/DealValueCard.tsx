'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Coins } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';
import { useStageLabel } from '@/lib/pipelineStagesClient';
import type { DealValueMonth } from '@/lib/dealValue';
import { DealValueTable } from '@/components/admin/DealValueTable';

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
    body = <DealValueTable months={data.months} currency={data.currency} />;
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
