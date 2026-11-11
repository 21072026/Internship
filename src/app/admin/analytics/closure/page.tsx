'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useT } from '@/i18n/client';
import type { ClosureReport, ClosureScores } from '@/lib/closureReport';

// How pairings ended (#1795): the pairings that ended in the period by outcome
// and end reason, with the close-loop survey's answers above the response
// floor. Only a COMPLETED ending reads as a success — every other outcome is
// labelled "not a completion", whatever its reason (src/lib/closureReport.ts).

interface Setup {
  surveyId: string;
  status: string;
  campaignActive: boolean;
}
type Report = ClosureReport & { from: string; to: string; setup: Setup | null };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function ClosureReportPage() {
  const t = useT();
  const c = t.closure;
  const reasons = t.relationLifecycle.reasons as Record<string, string>;
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 364 * 24 * 60 * 60 * 1000)));
  const [data, setData] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/analytics/closure?from=${from}&to=${to}`);
    if (res.ok) setData(await res.json());
  }, [from, to]);
  useEffect(() => {
    load();
  }, [load]);

  const setup = async () => {
    setBusy(true);
    await fetch('/api/admin/analytics/closure', { method: 'POST' }).catch(() => null);
    setBusy(false);
    await load();
  };

  const scores = (s: ClosureScores | null) =>
    s ? (
      <>
        <td className="px-3 py-2">{s.avgOverall ?? '—'}</td>
        <td className="px-3 py-2">{s.avgGoalsMet ?? '—'}</td>
        <td className="px-3 py-2">{s.nps.suppressed ? '—' : s.nps.score}</td>
      </>
    ) : (
      <td colSpan={3} className="px-3 py-2 text-xs text-gray-500">{c.hidden}</td>
    );

  const on = !!data?.setup?.campaignActive && data.setup.status === 'OPEN';

  return (
    <div className="space-y-6" data-testid="closure-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/admin/analytics" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400">
            <ArrowLeft className="h-4 w-4" /> {c.back}
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">{c.title}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">{c.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{c.from}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800" />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600 dark:text-gray-300">{c.to}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800" />
          </label>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{c.setupTitle}</CardTitle>
        </CardHeader>
        <p className="text-sm text-gray-600 dark:text-gray-300" data-testid="closure-setup-state">{on ? c.setupOn : c.setupOff}</p>
        {!on && (
          <Button className="mt-3" size="sm" loading={busy} onClick={setup} data-testid="closure-setup">
            {c.setupButton}
          </Button>
        )}
      </Card>

      {data && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [c.ended, data.relations],
              [c.successes, data.successes],
              [c.responseRate, data.responseRatePct === null ? '—' : `${data.responseRatePct}%`],
              [c.medianLength, data.medianLengthDays === null ? '—' : c.days.replace('{n}', String(data.medianLengthDays))],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
                <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100">{value}</p>
              </div>
            ))}
          </div>

          {data.groups.length === 0 ? (
            <p className="text-sm text-gray-500" data-testid="closure-empty">{c.none}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
              <table className="min-w-full text-sm" data-testid="closure-table">
                <thead className="text-left text-xs text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-2">{c.outcome}</th>
                    <th className="px-3 py-2">{c.reason}</th>
                    <th className="px-3 py-2">{c.relations}</th>
                    <th className="px-3 py-2">{c.invited}</th>
                    <th className="px-3 py-2">{c.responses}</th>
                    <th className="px-3 py-2">{c.avgOverall}</th>
                    <th className="px-3 py-2">{c.avgGoals}</th>
                    <th className="px-3 py-2">{c.nps}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {data.groups.map((g) => (
                    <tr key={`${g.outcome}|${g.reasonCode ?? ''}`} data-testid={`closure-row-${g.outcome}-${g.reasonCode ?? 'none'}`}>
                      <td className="px-3 py-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{c.outcomes[g.outcome]}</span>
                        <span className={`ml-2 text-xs ${g.success ? 'text-green-700 dark:text-green-400' : 'text-gray-500'}`} data-testid="closure-success">
                          {g.success ? c.success : c.notSuccess}
                        </span>
                      </td>
                      <td className="px-3 py-2">{g.reasonCode ? (reasons[g.reasonCode] ?? g.reasonCode) : c.noReason}</td>
                      <td className="px-3 py-2">{g.relations}</td>
                      <td className="px-3 py-2">{g.invited}</td>
                      <td className="px-3 py-2">{g.responses ?? '—'}</td>
                      {scores(g.scores)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
