'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useLocale, useT } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

// The mail queue tab (#2953): what is waiting, what could not be delivered,
// and the relay's pause — next to the delivery health it explains. Fed by
// GET /api/admin/mail-queue, which decides the scope (a super admin's world, or
// the default organization's own rows) and never returns an address: a row is
// its lane, category, product, attempts, a reason code and a short recipient
// fingerprint. The two actions are the server's guarded writes; the screen
// only offers them where the row says they apply.

type Lane = 'CRITICAL' | 'TRANSACTIONAL' | 'BULK';
type State = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER' | 'CANCELLED';
const LANES: Lane[] = ['CRITICAL', 'TRANSACTIONAL', 'BULK'];
const STATES: State[] = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER', 'CANCELLED'];

interface Row {
  id: string;
  status: string;
  lane: Lane;
  category: string | null;
  world: string | null;
  attempts: number;
  maxAttempts: number;
  reason: string | null;
  rcpt: string | null;
  queuedAt: string;
  notAfter: string | null;
  actionable: boolean;
  refusal: 'wrong_state' | 'expired' | 'no_envelope' | null;
}

interface Breaker {
  paused: boolean;
  pausedUntil: string | null;
  pauseLevel: number;
}

interface View {
  scope: 'world' | 'organization';
  counts: Record<Lane, Record<State, number>>;
  dead: Row[];
  waiting: Row[];
  breaker: Partial<Record<'primary' | 'bulk', Breaker>>;
  day?: Partial<Record<'primary' | 'bulk', { count: number; cap: number | null }>>;
}

export function MailQueuePanel() {
  const t = useT();
  const s = t.settings;
  const locale = useLocale();
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/admin/mail-queue')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setView(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id: string, action: 'retry' | 'cancel') => {
    setBusy(id);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/mail-queue/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      setNote(
        res.ok
          ? { ok: true, text: action === 'retry' ? s.mailQueueRetried : s.mailQueueCancelled }
          : { ok: false, text: s.mailQueueActionFailed },
      );
    } catch {
      setNote({ ok: false, text: s.mailQueueActionFailed });
    } finally {
      setBusy(null);
      setConfirmCancel(null);
      load();
    }
  };

  const laneLabel = (lane: Lane) => s[`mailQueueLane${lane}` as const];
  const stateLabel = (state: State) => s[`mailQueueState${state}` as const];

  if (!view) return <p className="text-xs text-gray-400" data-testid="mail-queue-loading">…</p>;

  const breakers = Object.entries(view.breaker) as ['primary' | 'bulk', Breaker][];
  const rowsTable = (rows: Row[], action: 'retry' | 'cancel', testId: string) =>
    rows.length === 0 ? (
      <p className="text-xs text-gray-400" data-testid={`${testId}-empty`}>{s.mailQueueEmpty}</p>
    ) : (
      /* tabIndex: the rows do not wrap, so a keyboard user must be able to
         pan the scroller (same trade-off as the delivery log above it). */
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full text-xs" data-testid={testId}>
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400">
              <th className="py-1 pr-2 font-medium">{s.mailQueueColWhen}</th>
              <th className="py-1 pr-2 font-medium">{s.mailQueueColLane}</th>
              <th className="py-1 pr-2 font-medium">{s.mailQueueColCategory}</th>
              <th className="py-1 pr-2 font-medium">{s.mailQueueColWorld}</th>
              <th className="py-1 pr-2 font-medium">{s.mailQueueColAttempts}</th>
              <th className="py-1 pr-2 font-medium">{s.mailQueueColReason}</th>
              <th className="py-1 pr-2 font-medium">{s.mailQueueColRecipient}</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-testid={`mail-queue-row-${r.id}`} className="border-t border-gray-100 dark:border-gray-800">
                <td className="py-1.5 pr-2 whitespace-nowrap text-gray-500 dark:text-gray-400">
                  <RelativeTime date={r.queuedAt} title={formatDateTime(r.queuedAt, locale)} />
                </td>
                <td className="py-1.5 pr-2 whitespace-nowrap">{laneLabel(r.lane)}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap">{r.category ?? '—'}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap text-gray-500 dark:text-gray-400">{r.world ?? '—'}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap">
                  {r.attempts}/{r.maxAttempts}
                </td>
                <td className="py-1.5 pr-2 whitespace-nowrap font-mono">{r.reason ?? '—'}</td>
                <td className="py-1.5 pr-2 whitespace-nowrap font-mono text-gray-500 dark:text-gray-400">{r.rcpt ?? '—'}</td>
                <td className="py-1.5 whitespace-nowrap text-right">
                  {r.actionable ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={action === 'cancel' ? 'outline' : 'secondary'}
                      loading={busy === r.id}
                      onClick={() => (action === 'cancel' ? setConfirmCancel(r.id) : act(r.id, 'retry'))}
                      data-testid={`mail-queue-${action}-${r.id}`}
                    >
                      {action === 'retry' ? s.mailQueueRetry : s.mailQueueCancel}
                    </Button>
                  ) : r.refusal === 'expired' ? (
                    <span className="text-gray-400">{s.mailQueueExpired}</span>
                  ) : r.refusal === 'no_envelope' ? (
                    <span className="text-gray-400">{s.mailQueueNoEnvelope}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="space-y-4" data-testid="mail-queue-panel">
      <p className="text-xs text-gray-500 dark:text-gray-400">{s.mailQueueHint}</p>
      {view.scope === 'organization' && <p className="text-xs text-gray-500 dark:text-gray-400">{s.mailQueueScopeOrg}</p>}

      <div className="space-y-1 text-sm" data-testid="mail-queue-breaker">
        {breakers.map(([channel, b]) => (
          <div key={channel}>
            {b.paused && b.pausedUntil ? (
              <span className="text-amber-700 dark:text-amber-400">
                ● {s.mailQueueBreakerPaused.replace('{t}', formatDateTime(b.pausedUntil, locale))}
              </span>
            ) : (
              <span className="text-green-700 dark:text-green-400">● {s.mailQueueBreakerOk}</span>
            )}
            {channel === 'bulk' && <span className="text-gray-400"> · {s.bulkTag}</span>}
            {view.day?.[channel] && (
              <span className="text-gray-500 dark:text-gray-400">
                {' · '}
                {view.day[channel]!.cap
                  ? s.mailQueueDay.replace('{n}', String(view.day[channel]!.count)).replace('{cap}', String(view.day[channel]!.cap))
                  : s.mailQueueDayNoCap.replace('{n}', String(view.day[channel]!.count))}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="overflow-x-auto" tabIndex={0}>
        <table className="w-full text-xs" data-testid="mail-queue-counts">
          <thead>
            <tr className="text-left text-gray-500 dark:text-gray-400">
              <th className="py-1 pr-2 font-medium" />
              {STATES.map((st) => (
                <th key={st} className="py-1 pr-2 font-medium whitespace-nowrap">{stateLabel(st)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LANES.map((lane) => (
              <tr key={lane} className="border-t border-gray-100 dark:border-gray-800">
                <th scope="row" className="py-1.5 pr-2 text-left font-medium whitespace-nowrap">{laneLabel(lane)}</th>
                {STATES.map((st) => (
                  <td key={st} className="py-1.5 pr-2 tabular-nums" data-testid={`mail-queue-count-${lane}-${st}`}>
                    {view.counts[lane]?.[st] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {note && (
        <p className={`text-sm ${note.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`} role="status">
          {note.text}
        </p>
      )}

      <div>
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">{s.mailQueueDead}</h3>
        {rowsTable(view.dead, 'retry', 'mail-queue-dead')}
      </div>
      <div>
        <div className="flex items-center justify-between gap-2 mb-1">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{s.mailQueueWaiting}</h3>
          <Button type="button" variant="ghost" size="sm" onClick={load}>{s.emailLogRefresh}</Button>
        </div>
        {rowsTable(view.waiting, 'cancel', 'mail-queue-waiting')}
      </div>

      <ConfirmDialog
        open={confirmCancel !== null}
        title={s.mailQueueCancelTitle}
        message={s.mailQueueCancelBody}
        confirmLabel={s.mailQueueCancel}
        cancelLabel={s.mailQueueKeep}
        variant="danger"
        loading={busy !== null}
        onConfirm={() => confirmCancel && act(confirmCancel, 'cancel')}
        onCancel={() => setConfirmCancel(null)}
      />
    </div>
  );
}
