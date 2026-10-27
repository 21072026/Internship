'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { fillTemplate } from '@/components/ui/fillTemplate';
import { useLocale, useT } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

// The operations console (#1607). Fed by GET /api/admin/operations, which
// decides the scope (the mail queue's operator rule) and computes every alarm;
// this screen only renders them. The integrations section is a roll-up over
// GET /api/admin/integrations/health (#2008) with a link to the full board —
// no connector rows here. "Run now" goes through the existing
// /api/cron?job=…&enqueue=1, which writes a JobRun with trigger 'manual'.

type Alarm = 'never_enqueued' | 'scheduler_behind' | 'worker_behind' | 'last_run_failed';
type ConnectorState = 'ok' | 'degraded' | 'failing' | 'not_configured';

interface ScheduleRow {
  key: string;
  job: string;
  cron: string;
  lastEnqueuedSlot: string | null;
  nextSlot: string | null;
  lastRun: { startedAt: string; finishedAt: string | null; ok: boolean; durationMs: number | null; trigger: string; error: string | null } | null;
  lastOkAt: string | null;
  alarms: Alarm[];
  rerunKey: string | null;
}

interface View {
  scope: 'world' | 'organization';
  schedules: ScheduleRow[];
  errors: { failedRunsLastHour: number; failedRunsLast24h: number; deadLetter: number };
  leases?: { name: string; holder: string; live: boolean; expiresAt: string }[];
}

const STATES: ConnectorState[] = ['ok', 'degraded', 'failing', 'not_configured'];
const STATE_VARIANT: Record<ConnectorState, 'success' | 'warning' | 'danger' | 'default'> = {
  ok: 'success',
  degraded: 'warning',
  failing: 'danger',
  not_configured: 'default',
};

export function OperationsConsole() {
  const t = useT();
  const o = t.operations;
  const locale = useLocale();
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState(false);
  const [connectors, setConnectors] = useState<{ state: ConnectorState }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    fetch('/api/admin/operations')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: View) => {
        setView(d);
        setFailed(false);
      })
      .catch(() => setFailed(true));
    fetch('/api/admin/integrations/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setConnectors(d.connectors))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rerun = async (key: string) => {
    setBusy(key);
    setNote(null);
    try {
      const res = await fetch(`/api/cron?job=${encodeURIComponent(key)}&enqueue=1`);
      setNote(res.ok ? { ok: true, text: o.rerunQueued } : { ok: false, text: o.rerunFailed });
      if (res.ok) load();
    } catch {
      setNote({ ok: false, text: o.rerunFailed });
    } finally {
      setBusy(null);
    }
  };

  const alarmLabel: Record<Alarm, string> = {
    never_enqueued: o.alarmNeverEnqueued,
    scheduler_behind: o.alarmSchedulerBehind,
    worker_behind: o.alarmWorkerBehind,
    last_run_failed: o.alarmLastRunFailed,
  };
  const triggerLabel: Record<string, string> = {
    schedule: o.triggerSchedule,
    manual: o.triggerManual,
    boot: o.triggerBoot,
    event: o.triggerEvent,
  };
  const stateLabel: Record<ConnectorState, string> = {
    ok: o.integrationsOk,
    degraded: o.integrationsDegraded,
    failing: o.integrationsFailing,
    not_configured: o.integrationsNotConfigured,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{o.title}</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">{o.subtitle}</p>
          {view && (
            <p className="mt-1 text-xs text-gray-500" data-testid="operations-scope" data-scope={view.scope}>
              {view.scope === 'world' ? o.scopeWorld : o.scopeOrg}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          {o.refresh}
        </Button>
      </div>

      {failed && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {o.loadFailed}
        </p>
      )}
      {note && (
        <p role="status" className={`text-sm ${note.ok ? 'text-green-700' : 'text-red-700'}`} data-testid="operations-note">
          {note.text}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{o.errorsTitle}</CardTitle>
          </CardHeader>
          {view ? (
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3" data-testid="operations-errors">
              {(
                [
                  [o.failedHour, view.errors.failedRunsLastHour],
                  [o.failedDay, view.errors.failedRunsLast24h],
                  [o.deadLetter, view.errors.deadLetter],
                ] as const
              ).map(([label, n]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-gray-500">{label}</dt>
                  <dd className={`text-xl font-semibold ${n > 0 ? 'text-red-700 dark:text-red-400' : 'text-gray-900 dark:text-gray-100'}`}>{n}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-gray-500">{o.loading}</p>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{o.integrationsTitle}</CardTitle>
          </CardHeader>
          <div className="flex flex-wrap gap-2" data-testid="operations-integrations">
            {connectors
              ? STATES.map((s) => (
                  <Badge key={s} variant={STATE_VARIANT[s]} data-state={s}>
                    {connectors.filter((c) => c.state === s).length} {stateLabel[s]}
                  </Badge>
                ))
              : <span className="text-sm text-gray-500">{o.loading}</span>}
          </div>
          <Link href="/admin/integrations" className="mt-3 inline-block text-sm text-blue-700 hover:underline dark:text-blue-400">
            {o.integrationsLink}
          </Link>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{o.schedulesTitle}</CardTitle>
        </CardHeader>
        {!view ? (
          <p className="text-sm text-gray-500">{o.loading}</p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="w-full text-xs" data-testid="operations-schedules">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="py-1 pr-3 font-medium">{o.colSchedule}</th>
                  <th className="py-1 pr-3 font-medium">{o.colAlarms}</th>
                  <th className="py-1 pr-3 font-medium">{o.colLastRun}</th>
                  <th className="py-1 pr-3 font-medium">{o.colOutcome}</th>
                  <th className="py-1 pr-3 font-medium">{o.colDuration}</th>
                  <th className="py-1 pr-3 font-medium">{o.colNext}</th>
                  <th className="py-1 font-medium">{o.colAction}</th>
                </tr>
              </thead>
              <tbody>
                {view.schedules.map((s) => {
                  const run = s.lastRun;
                  return (
                    <tr
                      key={s.key}
                      className="border-t border-gray-100 align-top dark:border-gray-800"
                      data-testid={`operations-schedule-${s.key}`}
                      data-alarm={s.alarms.length > 0 ? 'true' : 'false'}
                    >
                      <td className="py-1.5 pr-3">
                        <span className="font-mono text-gray-900 dark:text-gray-100">{s.key}</span>
                        <div className="font-mono text-[11px] text-gray-500">{s.cron}</div>
                      </td>
                      <td className="py-1.5 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {s.alarms.length === 0 ? (
                            <Badge variant="success">{o.healthy}</Badge>
                          ) : (
                            s.alarms.map((a) => (
                              <Badge key={a} variant="danger" data-alarm={a}>
                                {alarmLabel[a]}
                              </Badge>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {run ? (
                          <>
                            <RelativeTime date={run.startedAt} locale={locale} title={formatDateTime(run.startedAt, locale)} />
                            <div className="text-[11px] text-gray-500">{triggerLabel[run.trigger] ?? run.trigger}</div>
                          </>
                        ) : (
                          <span className="text-gray-500">{o.never}</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        {run && (
                          <>
                            <span className={!run.finishedAt ? 'text-gray-600' : run.ok ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}>
                              {!run.finishedAt ? o.outcomeRunning : run.ok ? o.outcomeOk : o.outcomeFailed}
                            </span>
                            {run.error && <div className="max-w-xs break-words text-[11px] text-gray-500">{run.error}</div>}
                            {!run.ok && s.lastOkAt && (
                              <div className="text-[11px] text-gray-500">
                                {fillTemplate(o.lastOk, { when: <RelativeTime date={s.lastOkAt} locale={locale} title={formatDateTime(s.lastOkAt, locale)} /> })}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{run?.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)} s` : '—'}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{s.nextSlot ? formatDateTime(s.nextSlot, locale) : '—'}</td>
                      <td className="py-1.5">
                        {s.rerunKey && (
                          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => rerun(s.rerunKey!)} data-testid={`operations-rerun-${s.key}`}>
                            {o.rerun}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {view?.leases && view.leases.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{o.leasesTitle}</CardTitle>
          </CardHeader>
          <ul className="space-y-1 text-sm" data-testid="operations-leases">
            {view.leases.map((l) => (
              <li key={l.name} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{l.name}</span>
                <span className="break-all text-gray-600 dark:text-gray-400">{fillTemplate(o.leaseHolder, { holder: l.holder })}</span>
                <Badge variant={l.live ? 'success' : 'danger'}>{l.live ? o.leaseLive : o.leaseExpired}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
