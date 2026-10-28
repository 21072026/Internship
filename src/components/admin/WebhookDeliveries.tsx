'use client';

// The delivery log of one webhook (#1695): the last attempts with their
// status, response code, attempt number, duration and error, a replay button
// per attempt and a "replay last N events" action for the hook. Every write
// goes through the ADMIN-only, org-scoped routes under /api/admin/webhooks.
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useT } from '@/i18n/client';

interface Delivery {
  id: string;
  eventName: string;
  attempt: number;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'DEAD';
  responseCode: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

const STATUS_CLASS: Record<Delivery['status'], string> = {
  PENDING: 'bg-gray-100 text-gray-700',
  SUCCESS: 'bg-green-100 text-green-800',
  FAILED: 'bg-amber-100 text-amber-800',
  DEAD: 'bg-red-100 text-red-800',
};

export function WebhookDeliveries({ hookId }: { hookId: string }) {
  const t = useT();
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [note, setNote] = useState('');
  const [count, setCount] = useState('10');

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/webhooks/deliveries?webhookId=${encodeURIComponent(hookId)}&limit=25`);
    setRows(res.ok ? ((await res.json()).deliveries ?? []) : []);
  }, [hookId]);
  useEffect(() => { void load(); }, [load]);

  const explain = async (res: Response) => {
    if (res.ok) return null;
    const d = await res.json().catch(() => ({}));
    if (d.error === 'disabled') return t.integrations.replayDisabled;
    if (d.error === 'event_gone') return t.integrations.replayGone;
    return t.integrations.replayFailed;
  };

  const replay = async (id: string) => {
    const res = await fetch(`/api/admin/webhooks/deliveries/${encodeURIComponent(id)}/replay`, { method: 'POST' });
    setNote((await explain(res)) ?? t.integrations.replayQueued);
  };
  const replayLast = async () => {
    const res = await fetch(`/api/admin/webhooks/replay-events?id=${encodeURIComponent(hookId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: Number(count) }),
    });
    const problem = await explain(res);
    if (problem) { setNote(problem); return; }
    const d = await res.json().catch(() => ({ queued: 0 }));
    setNote(t.integrations.replayLastQueued.replace('{n}', String(d.queued ?? 0)));
  };

  return (
    <div className="mt-2 space-y-2" data-testid={`webhook-deliveries-${hookId}`}>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t.integrations.deliverySemantics}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300">
          {t.integrations.replayLastCount}
          <input
            type="number" min={1} max={50} step={1} value={count} onChange={(e) => setCount(e.target.value)}
            data-testid={`webhook-replay-count-${hookId}`}
            className="w-16 rounded border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
          />
        </label>
        <Button size="sm" variant="secondary" data-testid={`webhook-replay-last-${hookId}`} onClick={() => void replayLast()}>
          {t.integrations.replayLast}
        </Button>
        {note && <span role="status" className="text-xs text-gray-600 dark:text-gray-300">{note}</span>}
      </div>
      {rows === null ? null : rows.length === 0 ? (
        <p className="text-xs text-gray-400">{t.integrations.deliveriesEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid={`webhook-deliveries-table-${hookId}`}>
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400">
                <th className="py-1 pr-2 font-medium">{t.integrations.deliveryWhen}</th>
                <th className="py-1 pr-2 font-medium">{t.integrations.deliveryEvent}</th>
                <th className="py-1 pr-2 font-medium">{t.integrations.deliveryStatus}</th>
                <th className="py-1 pr-2 font-medium">{t.integrations.deliveryCode}</th>
                <th className="py-1 pr-2 font-medium">{t.integrations.deliveryAttempt}</th>
                <th className="py-1 pr-2 font-medium">{t.integrations.deliveryDuration}</th>
                <th className="py-1 pr-2 font-medium">{t.integrations.deliveryError}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((r) => (
                <tr key={r.id} data-testid={`webhook-delivery-${r.id}`}>
                  <td className="py-1 pr-2 whitespace-nowrap"><RelativeTime date={r.createdAt} /></td>
                  <td className="py-1 pr-2 font-mono">{r.eventName}</td>
                  <td className="py-1 pr-2">
                    <span className={`rounded-full px-2 py-0.5 ${STATUS_CLASS[r.status]}`}>
                      {t.integrations[`deliveryStatus${r.status}` as const]}
                    </span>
                  </td>
                  <td className="py-1 pr-2">{r.responseCode ?? '—'}</td>
                  <td className="py-1 pr-2">{r.attempt}</td>
                  <td className="py-1 pr-2">{r.durationMs != null ? `${r.durationMs} ms` : '—'}</td>
                  <td className="py-1 pr-2 max-w-[16rem] truncate" title={r.error ?? undefined}>{r.error ?? ''}</td>
                  <td className="py-1 text-right">
                    {r.status !== 'PENDING' && (
                      <button type="button" className="text-blue-600 hover:underline" data-testid={`webhook-replay-${r.id}`} onClick={() => void replay(r.id)}>
                        {t.integrations.replay}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
