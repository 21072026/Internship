'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, BarChart3, BellRing, Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useLocale, useT } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import type { SurveyCompletion } from '@/lib/surveyCompletion';

// A survey's completion console (#1889): who still owes an answer, and the
// nudge. What the server leaves out stays out — an anonymous survey's payload
// carries no people, so this screen has none to draw (src/lib/surveyCompletion.ts).

type Wire = Omit<SurveyCompletion, 'pending'> & {
  pending: { invitationId: string; name: string | null; email: string; remindersSent: number; lastRemindedAt: string | null; cannotRemind: string | null }[] | null;
};

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));

export default function SurveyCompletionPage() {
  const t = useT();
  const c = t.surveyCompletion;
  const r = t.surveyResults;
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Wire | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/surveys/${id}/completion`);
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()).completion);
    } catch {
      setError(t.common.error);
    }
  }, [id, t.common.error]);

  useEffect(() => {
    load();
  }, [load]);

  const remind = async (invitationIds?: string[]) => {
    setBusy(invitationIds?.[0] ?? 'all');
    setStatus('');
    try {
      const res = await fetch(`/api/admin/surveys/${id}/remind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invitationIds ? { invitationIds } : {}),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { result } = await res.json();
      setStatus(fill(c.sent, { n: result.sent }));
      await load();
    } catch {
      setStatus(t.common.error);
    } finally {
      setBusy('');
    }
  };

  const reason = (why: string) => (c as Record<string, string>)[`why_${why}`] ?? why;
  const pendingTotal = data ? data.pendingByReminders.reduce((a, b) => a + b, 0) : 0;
  const answeredPct = data && data.rate !== null ? data.rate : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/admin/surveys" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-blue-600 dark:text-blue-400">
          <ArrowLeft className="h-4 w-4" /> {r.back}
        </Link>
        <Link href={`/admin/surveys/${id}/results`} className="inline-flex min-h-[44px] items-center gap-1 text-sm text-blue-600 dark:text-blue-400" data-testid="completion-results-link">
          <BarChart3 className="h-4 w-4" /> {r.viewResults}
        </Link>
      </div>
      {error && <p className="text-red-600" role="alert">{error}</p>}
      {!data && !error && <p className="text-gray-500">{t.common.loading}</p>}
      {data && (
        <>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 break-words">{data.survey.title || c.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-500">
              <Badge variant="purple">{(r as Record<string, string>)[`anonymity_${data.survey.anonymity}`]}</Badge>
              <span>{c.title}</span>
            </div>
          </div>

          <Card data-testid="completion-progress">
            <p className="text-sm text-gray-600 dark:text-gray-300">{fill(c.invited, { n: data.invited })}</p>
            {answeredPct !== null ? (
              <>
                <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="completion-rate">
                  {fill(c.answeredOf, { responded: data.responded ?? 0, invited: data.invited, rate: answeredPct })}
                </p>
                <div className="mt-3 h-3 overflow-hidden rounded bg-gray-100 dark:bg-gray-800" aria-hidden="true">
                  <span className="block h-3 bg-green-500" style={{ width: `${answeredPct}%` }} />
                </div>
              </>
            ) : (
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300" data-testid="completion-below-floor">{fill(c.belowFloor, { floor: data.floor })}</p>
            )}
            <h2 className="mt-4 text-sm font-medium text-gray-700 dark:text-gray-200">{c.byReminders}</h2>
            <ul className="mt-1 flex flex-wrap gap-2 text-sm" data-testid="completion-by-reminders">
              {data.pendingByReminders.map((count, k) => (
                <li key={k} className="rounded-lg border border-gray-200 px-2 py-1 dark:border-gray-700">
                  {fill(c.reminderBucket, { k, max: data.maxReminders })}: <span className="font-medium">{count}</span>
                </li>
              ))}
            </ul>
            {pendingTotal > 0 && (
              <Button className="mt-4" variant="outline" onClick={() => remind()} loading={busy === 'all'} disabled={!!busy} data-testid="remind-all">
                <BellRing className="mr-1 h-4 w-4" /> {c.remindAll}
              </Button>
            )}
            <p className="mt-2 text-xs text-gray-500">{fill(c.capNote, { max: data.maxReminders })}</p>
            {status && <p className="mt-2 text-sm text-gray-700 dark:text-gray-200" role="status" data-testid="remind-status">{status}</p>}
          </Card>

          {data.pending === null ? (
            <Card data-testid="completion-anonymous">
              <p className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200"><Lock className="mt-0.5 h-4 w-4 shrink-0" /> {c.anonymousBanner}</p>
            </Card>
          ) : (
            <Card>
              <h2 className="mb-3 font-semibold text-gray-900 dark:text-gray-100">{c.pendingTitle}</h2>
              {data.pending.length === 0 ? (
                <p className="text-sm text-gray-500">{c.pendingEmpty}</p>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="completion-pending">
                  {data.pending.map((p) => (
                    <li key={p.invitationId} className="flex flex-wrap items-center gap-3 py-2" data-testid={`pending-${p.invitationId}`}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-gray-900 dark:text-gray-100">{p.name ?? p.email}</p>
                        <p className="text-xs text-gray-500">
                          {fill(c.reminderState, { n: p.remindersSent, max: data.maxReminders })}
                          {p.lastRemindedAt && ` · ${fill(c.lastReminded, { date: formatDate(p.lastRemindedAt, locale) })}`}
                        </p>
                      </div>
                      {p.cannotRemind ? (
                        <span className="text-xs text-gray-500" data-testid={`cannot-remind-${p.invitationId}`}>{reason(p.cannotRemind)}</span>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => remind([p.invitationId])} loading={busy === p.invitationId} disabled={!!busy} data-testid={`remind-${p.invitationId}`}>
                          {c.remind}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
