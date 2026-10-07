'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { LoadErrorCard } from '@/components/ui/LoadErrorCard';
import { useLocale, useT } from '@/i18n/client';
import { formatUsd, recentPeriods, successRate, type TaskUsage, type UsageTotals } from '@/lib/ai/consoleRules';

// /admin/ai (#2030) — what AI costs this organisation. Reads
// GET /api/admin/ai/usage (the month and the one before, aggregated in SQL)
// and GET /api/admin/ai/status (key configured?, model per task, breaker,
// injection flags). The quota is the same `aiMonthlyQuota` setting the gate
// enforces, saved through PUT /api/admin/settings like the settings page does.

interface MonthUsage { period: string; tasks: TaskUsage[]; totals: UsageTotals }
interface UsageBody { month: string; current: MonthUsage; previous: MonthUsage; quota: { quota: number; used: number; remaining: number } }
interface StatusBody {
  configured: boolean;
  breaker: 'closed' | 'open' | 'half-open';
  flaggedCalls: number;
  flagWindowDays: number;
  tasks: { id: string; label: string; audience: 'participant' | 'operator'; tier: string; model: string }[];
}

const thisMonth = () => new Date().toISOString().slice(0, 7);
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
/** Counts in the app's language, never the browser's (check:locale-dates). */
const numIn = (locale: string) => (n: number) => n.toLocaleString(locale);

function UsageTable({ usage, labels, testId }: { usage: MonthUsage; labels: Record<string, string>; testId: string }) {
  const a = useT().adminAi;
  const num = numIn(useLocale());
  const ms = (n: number | null) => (n === null ? '—' : `${num(n)} ms`);
  if (usage.tasks.length === 0) return <p className="text-sm text-gray-500 dark:text-gray-400" data-testid={`${testId}-empty`}>{a.empty}</p>;
  const row = (key: string, r: TaskUsage | (UsageTotals & { task?: string; p50LatencyMs?: null; p95LatencyMs?: null }), name: string, strong = false) => {
    const rate = successRate(r);
    return (
      <tr key={key} className={strong ? 'font-semibold border-t-2 border-gray-200 dark:border-gray-700' : 'border-t border-gray-100 dark:border-gray-800'} data-testid={`${testId}-row-${key}`}>
        <td className="py-2 pr-3">{name}</td>
        <td className="py-2 pr-3 text-right tabular-nums" data-testid={`${testId}-calls-${key}`}>{num(r.calls)}</td>
        <td className="py-2 pr-3 text-right tabular-nums">{rate === null ? '—' : `${rate}%`}</td>
        <td className="py-2 pr-3 text-right tabular-nums" data-testid={`${testId}-parse-${key}`}>{num(r.parseErrors)}</td>
        <td className="py-2 pr-3 text-right tabular-nums" data-testid={`${testId}-provider-${key}`}>{num(r.providerErrors)}</td>
        <td className="py-2 pr-3 text-right tabular-nums">{num(r.inputTokens)} / {num(r.outputTokens)}</td>
        <td className="py-2 pr-3 text-right tabular-nums" data-testid={`${testId}-spend-${key}`}>{formatUsd(r.costMicros)}{r.unpricedCalls > 0 ? '*' : ''}</td>
        <td className="py-2 text-right tabular-nums">{'p95LatencyMs' in r && r.p95LatencyMs !== undefined ? `${ms(r.p50LatencyMs ?? null)} / ${ms(r.p95LatencyMs ?? null)}` : ''}</td>
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm text-gray-800 dark:text-gray-200" data-testid={testId}>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th className="py-2 pr-3 font-medium">{a.colTask}</th>
            <th className="py-2 pr-3 font-medium text-right">{a.colCalls}</th>
            <th className="py-2 pr-3 font-medium text-right">{a.colSuccess}</th>
            <th className="py-2 pr-3 font-medium text-right">{a.colParse}</th>
            <th className="py-2 pr-3 font-medium text-right">{a.colProvider}</th>
            <th className="py-2 pr-3 font-medium text-right">{a.colTokens}</th>
            <th className="py-2 pr-3 font-medium text-right">{a.colSpend}</th>
            <th className="py-2 font-medium text-right">{a.colP95}</th>
          </tr>
        </thead>
        <tbody>
          {usage.tasks.map((r) => row(r.task, r, labels[r.task] ?? r.task))}
          {row('total', usage.totals, a.totals, true)}
        </tbody>
      </table>
      {usage.totals.unpricedCalls > 0 && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">* {a.unpriced.replace('{n}', num(usage.totals.unpricedCalls))}</p>}
    </div>
  );
}

export default function AdminAiPage() {
  const t = useT();
  const a = t.adminAi;
  const num = numIn(useLocale());
  const [month, setMonth] = useState(thisMonth);
  // Only a well-formed period ever reaches a URL — the select's value is DOM text.
  const period = PERIOD.test(month) ? month : thisMonth();
  const [usage, setUsage] = useState<UsageBody | null>(null);
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [failed, setFailed] = useState(false);
  const [quotaInput, setQuotaInput] = useState('');
  const [quotaMsg, setQuotaMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [u, s] = await Promise.all([fetch(`/api/admin/ai/usage?month=${encodeURIComponent(period)}`), fetch('/api/admin/ai/status')]);
      if (!u.ok || !s.ok) throw new Error('load');
      const body = (await u.json()) as UsageBody;
      setUsage(body);
      setStatus((await s.json()) as StatusBody);
      setQuotaInput(String(body.quota.quota));
    } catch {
      setFailed(true);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveQuota = async () => {
    const value = quotaInput.trim();
    if (!/^\d{1,6}$/.test(value)) {
      setQuotaMsg({ ok: false, text: a.quotaInvalid });
      return;
    }
    setSaving(true);
    setQuotaMsg(null);
    try {
      const res = await fetch('/api/admin/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiMonthlyQuota: value }) });
      if (!res.ok) throw new Error('save');
      setQuotaMsg({ ok: true, text: a.quotaSaved });
      await load();
    } catch {
      setQuotaMsg({ ok: false, text: t.common.error });
    } finally {
      setSaving(false);
    }
  };

  const labels = Object.fromEntries((status?.tasks ?? []).map((x) => [x.id, x.label]));
  const quota = usage?.quota;
  const pct = quota && quota.quota > 0 ? Math.min(100, Math.round((quota.used / quota.quota) * 100)) : 0;
  const breakerText = status ? { closed: a.breakerClosed, open: a.breakerOpen, 'half-open': a.breakerHalfOpen }[status.breaker] : '';

  return (
    <div className="max-w-6xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
            <Sparkles className="h-6 w-6 text-indigo-600" aria-hidden /> {a.title}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{a.intro}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="ai-console-scope">{a.scopeNote}</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-sm text-gray-700 dark:text-gray-300">
            <span className="mb-1 block text-xs font-medium">{a.month}</span>
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800"
              data-testid="ai-console-month"
            >
              {recentPeriods(thisMonth()).map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <a
            href={`/api/admin/ai/usage?month=${encodeURIComponent(period)}&format=csv`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
            data-testid="ai-console-csv"
          >
            <Download className="h-4 w-4" aria-hidden /> {a.csv}
          </a>
        </div>
      </div>

      {failed && <LoadErrorCard onRetry={() => void load()} testId="ai-console-error" />}
      {!usage || !status ? (
        !failed && <Card className="p-6"><SkeletonRows rows={6} /></Card>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="p-5" data-testid="ai-console-quota">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{a.quotaTitle}</h2>
              {quota && quota.quota > 0 ? (
                <>
                  <p className="mt-2 text-sm text-gray-700 dark:text-gray-300" data-testid="ai-console-quota-used">
                    {a.quotaUsed.replace('{used}', num(quota.used)).replace('{quota}', num(quota.quota))}
                  </p>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                    <div className={`h-full ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
                  </div>
                </>
              ) : (
                <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400" data-testid="ai-console-quota-off">{a.quotaOff}</p>
              )}
              <div className="mt-4 flex items-end gap-2">
                <div className="w-40">
                  <Input
                    label={a.quotaTitle}
                    type="number"
                    min={0}
                    max={999999}
                    step={1}
                    value={quotaInput}
                    onChange={(e) => { setQuotaInput(e.target.value); setQuotaMsg(null); }}
                    data-testid="ai-console-quota-input"
                  />
                </div>
                <Button type="button" onClick={() => void saveQuota()} loading={saving} data-testid="ai-console-quota-save">{a.quotaSave}</Button>
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{a.quotaHint}</p>
              {quotaMsg && (
                <p role={quotaMsg.ok ? 'status' : 'alert'} className={`mt-2 text-sm ${quotaMsg.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`} data-testid="ai-console-quota-msg">
                  {quotaMsg.text}
                </p>
              )}
            </Card>

            <Card className="p-5" data-testid="ai-console-status">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{a.statusTitle}</h2>
              <p className={`mt-2 text-sm font-medium ${status.configured ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`} data-testid="ai-console-configured">
                {status.configured ? a.configured : a.notConfigured}
              </p>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300" data-testid="ai-console-breaker">
                {a.breaker}: {breakerText}
              </p>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300" data-testid="ai-console-flagged">
                {(status.flaggedCalls > 0 ? a.flagged : a.flaggedNone).replace('{n}', num(status.flaggedCalls)).replace('{days}', String(status.flagWindowDays))}
              </p>
            </Card>
          </div>

          <Card className="p-5">
            <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">{a.tableTitle} · {usage.current.period}</h2>
            <UsageTable usage={usage.current} labels={labels} testId="ai-usage-current" />
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">{a.previousTitle.replace('{month}', usage.previous.period)}</h2>
            <UsageTable usage={usage.previous} labels={labels} testId="ai-usage-previous" />
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">{a.modelsTitle}</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-gray-800 dark:text-gray-200" data-testid="ai-console-models">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <th className="py-2 pr-3 font-medium">{a.colTask}</th>
                    <th className="py-2 pr-3 font-medium">{a.colAudience}</th>
                    <th className="py-2 font-medium">{a.colModel}</th>
                  </tr>
                </thead>
                <tbody>
                  {status.tasks.map((x) => (
                    <tr key={x.id} className="border-t border-gray-100 dark:border-gray-800">
                      <td className="py-2 pr-3">{x.label}</td>
                      <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{x.audience === 'participant' ? a.audienceParticipant : a.audienceOperator}</td>
                      <td className="py-2 font-mono text-xs">{x.model}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
