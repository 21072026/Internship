'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { DESTINATIONS, OUTCOME_DEFAULT_OFFSET, OUTCOME_OFFSETS, destinationLabels, type OutcomeBucket, type OutcomeSummary } from '@/lib/outcomeDestination';

// First destination (#1912): where participants ended up, and — on the same
// line, always — how many of them we know about. The page doubles as the
// report pack a coordinator files: "Print report" lays it out on one page
// (globals.css, #outcomes-print) with the period, N, knowledge rate, the
// destination table and the programme's NPS.

interface Setup {
  surveyId: string;
  status: string;
  campaigns: { id: string; dayOffset: number | null; active: boolean }[];
}
type Report = OutcomeSummary & { from: string; to: string; setup: Setup | null };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

export default function OutcomesPage() {
  const t = useT();
  const o = t.outcomes;
  const locale = useLocale();
  const labels = destinationLabels(locale === 'tr' || locale === 'de' ? locale : 'en');
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 364 * 24 * 60 * 60 * 1000)));
  const [data, setData] = useState<Report | null>(null);
  const [nps, setNps] = useState<{ value: number; basis: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(String(OUTCOME_DEFAULT_OFFSET));

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`/api/admin/analytics/outcomes?${new URLSearchParams({ from, to })}`);
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
    } catch {
      setError(t.common.error);
    }
  }, [from, to, t.common.error]);

  useEffect(() => {
    load();
  }, [load]);

  // The programme's NPS for the pack — the scorecard's own number, so the two
  // never disagree. Optional: a scorecard that cannot be read leaves it out.
  useEffect(() => {
    fetch('/api/admin/analytics/scorecard')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const row = (d?.rows ?? d?.scorecard ?? []).find((r: { key: string }) => r.key === 'nps');
        if (row?.status === 'ok') setNps({ value: row.value, basis: row.basis });
      })
      .catch(() => {});
  }, []);

  const setUp = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/analytics/outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dayOffset: Number(offset) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      await load();
    } catch {
      setError(t.common.error);
    } finally {
      setBusy(false);
    }
  };

  const floorNote = (n: number) => o.belowFloor.replace('{n}', String(n));
  const groupName = (b: OutcomeBucket) => b.label ?? o.noGroup;
  const offsets = (data?.setup?.campaigns ?? []).filter((c) => c.active && c.dayOffset !== null).map((c) => c.dayOffset!) ;
  const missingOffsets = OUTCOME_OFFSETS.filter((n) => !offsets.includes(n));

  const breakdown = (title: string, rows: OutcomeBucket[], testId: string) =>
    rows.length > 0 && (
      <Card className="mb-4" data-testid={testId}>
        <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <th className="py-2 pr-3">{o.colGroup}</th>
                <th className="py-2 pr-3 text-right">{o.colEligible}</th>
                <th className="py-2 pr-3 text-right">{o.colKnown}</th>
                <th className="py-2 pr-3 text-right">{o.colRate}</th>
                <th className="py-2 pr-3 text-right">{o.placed}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((b) => (
                <tr key={b.label ?? '∅'} className="text-gray-900 dark:text-gray-100">
                  <td className="py-2 pr-3">{groupName(b)}</td>
                  <td className="py-2 pr-3 text-right">{b.eligible}</td>
                  <td className="py-2 pr-3 text-right">{b.known}</td>
                  <td className="py-2 pr-3 text-right">{pct(b.knowledgeRate)}</td>
                  <td className="py-2 pr-3 text-right" title={b.destinations ? undefined : floorNote(data!.floor)}>
                    {b.destinations ? pct(b.placedRate) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    );

  const overall = data?.overall;

  return (
    <div id="outcomes-print" className="max-w-5xl">
      <div className="no-print mb-4">
        <Link href="/admin/analytics" className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:underline">
          <ArrowLeft className="h-4 w-4" /> {t.executive.back}
        </Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            <span className="no-print">{o.title}</span>
            <span className="hidden print:inline">{o.packTitle}</span>
          </h1>
          <p className="text-gray-500 mt-1 no-print">{o.subtitle}</p>
          {data && (
            <p className="text-xs text-gray-500 mt-1" data-testid="outcomes-period">
              {o.packPeriod.replace('{from}', formatDate(data.from, locale)).replace('{to}', formatDate(data.to, locale))}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" className="no-print" onClick={() => window.print()} data-testid="outcomes-print-button">
          <Printer className="mr-1 h-4 w-4" /> {o.print}
        </Button>
      </div>

      <div className="no-print grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6 max-w-lg">
        <label className="text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1.5">{o.from}</span>
          <input type="date" value={from} max={to} onChange={(ev) => ev.target.value && setFrom(ev.target.value)} data-testid="outcomes-from" className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-2 text-sm" />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300 mb-1.5">{o.to}</span>
          <input type="date" value={to} min={from} onChange={(ev) => ev.target.value && setTo(ev.target.value)} data-testid="outcomes-to" className="block w-full rounded-lg border border-gray-300 dark:border-gray-600 dark:bg-gray-900 px-3 py-2 text-sm" />
        </label>
      </div>

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {data && (
        <Card className="no-print mb-6" data-testid="outcomes-setup">
          <CardHeader><CardTitle>{o.setupTitle}</CardTitle></CardHeader>
          {data.setup ? (
            <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="outcomes-setup-active">
              {o.setupActive.replace('{list}', offsets.map((n) => o.offsetDays.replace('{n}', String(n))).join(', ') || '—')}
            </p>
          ) : (
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">{o.setupNone}</p>
          )}
          {missingOffsets.length > 0 && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-[160px]">
                <Select
                  label={data.setup ? o.addOffset : o.offsetLabel}
                  value={missingOffsets.includes(Number(offset) as (typeof OUTCOME_OFFSETS)[number]) ? offset : String(missingOffsets[0])}
                  onChange={(ev) => setOffset(ev.target.value)}
                  data-testid="outcomes-offset"
                  options={missingOffsets.map((n) => ({ value: String(n), label: o.offsetDays.replace('{n}', String(n)) }))}
                />
              </div>
              <Button size="sm" loading={busy} onClick={setUp} data-testid="outcomes-setup-button">
                {data.setup ? o.add : o.setupButton}
              </Button>
            </div>
          )}
        </Card>
      )}

      {overall && overall.eligible === 0 && <p className="text-gray-500 py-8 text-center" data-testid="outcomes-empty">{o.empty}</p>}

      {overall && overall.eligible > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6" data-testid="outcomes-headline">
            {[
              [o.eligible, String(overall.eligible), 'eligible'],
              [o.known, String(overall.known), 'known'],
              [o.knowledgeRate, pct(overall.knowledgeRate), 'rate'],
              [o.placed, overall.destinations ? pct(overall.placedRate) : '—', 'placed'],
            ].map(([label, value, id]) => (
              <Card key={id} padding="sm" data-testid={`outcomes-tile-${id}`}>
                <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
              </Card>
            ))}
          </div>

          <Card className="mb-4" data-testid="outcomes-destinations">
            <CardHeader><CardTitle>{o.overall}</CardTitle></CardHeader>
            {overall.destinations ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <th className="py-2 pr-3">{o.colDestination}</th>
                    <th className="py-2 pr-3 text-right">{o.colCount}</th>
                    <th className="py-2 pr-3 text-right">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {DESTINATIONS.map((d) => (
                    <tr key={d} className="text-gray-900 dark:text-gray-100" data-testid={`outcomes-row-${d}`}>
                      <td className="py-2 pr-3">{labels[d]}</td>
                      <td className="py-2 pr-3 text-right">{overall.destinations![d]}</td>
                      <td className="py-2 pr-3 text-right">{overall.known > 0 ? pct(overall.destinations![d] / overall.known) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-gray-500" data-testid="outcomes-below-floor">{floorNote(data!.floor)}</p>
            )}
            {overall.withheld > 0 && (
              <p className="mt-3 text-xs text-gray-500">{o.withheld}: {overall.withheld}</p>
            )}
          </Card>

          {breakdown(o.byCohort, data!.byCohort, 'outcomes-by-cohort')}
          {breakdown(o.bySource, data!.bySource, 'outcomes-by-source')}

          {nps && (
            <p className="text-sm text-gray-700 dark:text-gray-300 mb-2" data-testid="outcomes-nps">
              {o.packNps}: <strong>{nps.value}</strong> (n = {nps.basis})
            </p>
          )}
          <p className="text-xs text-gray-500">{o.packNote.replace('{n}', String(data!.floor))}</p>
        </>
      )}
    </div>
  );
}
