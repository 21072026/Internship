'use client';

import { useFilterAnnouncement, resultCountMessage } from '@/hooks/useFilterAnnouncement';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useLocale, useT } from '@/i18n/client';
import { formatDateTime } from '@/lib/relativeTime';

// The bounce/complaint suppression list (#1692), next to the mail queue in the
// admin mail settings. Fed by GET /api/admin/email-suppressions, which decides
// the scope (the mail queue's: a super admin's world, or the default
// organization's own users). A delist needs a reason, and a complaint an
// explicit "I understand"; the server enforces both and records the actor.

type Reason = 'HARD_BOUNCE' | 'SOFT_BOUNCE_REPEATED' | 'COMPLAINT' | 'MANUAL' | 'UNSUBSCRIBE_ALL';

interface Row {
  id: string;
  email: string;
  reason: Reason;
  detail: string | null;
  source: string | null;
  suppressedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
}

export function EmailSuppressionPanel({ scopeOrg }: { scopeOrg?: boolean }) {
  const t = useT();
  const s = t.settings;
  const locale = useLocale();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [q, setQ] = useState('');
  // WCAG 4.1.3 (#2864): the list is rewritten in place without moving focus,
  // so the new result count is spoken (debounced) while a filter is active.
  useFilterAnnouncement(rows && q.trim() !== '' ? resultCountMessage(t.a11y, rows.length) : null);
  const [showReleased, setShowReleased] = useState(false);
  const [target, setTarget] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (showReleased) params.set('released', '1');
    fetch(`/api/admin/email-suppressions?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setRows(d.rows);
        setTruncated(!!d.truncated);
      })
      .catch(() => {});
  }, [q, showReleased]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const close = () => {
    setTarget(null);
    setReason('');
    setUnderstood(false);
  };

  const delist = async () => {
    if (!target) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/email-suppressions/${encodeURIComponent(target.id)}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, confirm: target.reason === 'COMPLAINT' ? understood : false }),
      });
      setNote(res.ok ? { ok: true, text: s.suppressionsDelisted } : { ok: false, text: s.suppressionsDelistFailed });
    } catch {
      setNote({ ok: false, text: s.suppressionsDelistFailed });
    } finally {
      setBusy(false);
      close();
      load();
    }
  };

  const reasonLabel = (r: Reason) => s[`suppressionReason${r}` as const];
  const canDelist = reason.trim().length >= 3 && (target?.reason !== 'COMPLAINT' || understood);

  return (
    <div className="space-y-3" data-testid="email-suppression-panel">
      <p className="text-xs text-gray-500 dark:text-gray-400">{s.suppressionsHint}</p>
      {scopeOrg && <p className="text-xs text-gray-500 dark:text-gray-400">{s.suppressionsScopeOrg}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={s.suppressionsSearch}
          aria-label={s.suppressionsSearch}
          data-testid="email-suppression-search"
          className="min-h-9 w-64 max-w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm"
        />
        <label className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <input type="checkbox" checked={showReleased} onChange={(e) => setShowReleased(e.target.checked)} data-testid="email-suppression-show-released" />
          {s.suppressionsShowReleased}
        </label>
      </div>
      {note && (
        <p role="status" className={`text-sm ${note.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`} data-testid="email-suppression-note">
          {note.text}
        </p>
      )}
      {rows === null ? (
        <p className="text-xs text-gray-400">…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-400" data-testid="email-suppression-empty">{s.suppressionsEmpty}</p>
      ) : (
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full text-xs" data-testid="email-suppression-table">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400">
                <th className="py-1 pr-2 font-medium">{s.suppressionsColAddress}</th>
                <th className="py-1 pr-2 font-medium">{s.suppressionsColReason}</th>
                <th className="py-1 pr-2 font-medium">{s.suppressionsColWhen}</th>
                <th className="py-1 pr-2 font-medium">{s.suppressionsColSource}</th>
                <th className="py-1 pr-2 font-medium">{s.suppressionsColDetail}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid={`email-suppression-row-${r.id}`} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="py-1.5 pr-2 whitespace-nowrap font-mono">{r.email}</td>
                  <td className="py-1.5 pr-2 whitespace-nowrap">{reasonLabel(r.reason)}</td>
                  <td className="py-1.5 pr-2 whitespace-nowrap text-gray-500 dark:text-gray-400">
                    <RelativeTime date={r.suppressedAt} title={formatDateTime(r.suppressedAt, locale)} />
                  </td>
                  <td className="py-1.5 pr-2 whitespace-nowrap text-gray-500 dark:text-gray-400">{r.source ?? '—'}</td>
                  <td className="py-1.5 pr-2 max-w-xs truncate text-gray-500 dark:text-gray-400" title={r.detail ?? undefined}>
                    {r.detail ?? '—'}
                  </td>
                  <td className="py-1.5 whitespace-nowrap text-right">
                    {r.releasedAt ? (
                      <span className="text-gray-400" title={r.releaseReason ?? undefined}>
                        {s.suppressionsReleasedOn} <RelativeTime date={r.releasedAt} title={formatDateTime(r.releasedAt, locale)} />
                      </span>
                    ) : (
                      <Button type="button" size="sm" variant="outline" onClick={() => setTarget(r)} data-testid={`email-suppression-delist-${r.id}`}>
                        {s.suppressionsDelist}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && <p className="text-xs text-gray-400">{s.suppressionsTruncated}</p>}
      <ConfirmDialog
        open={!!target}
        title={s.suppressionsDelistTitle}
        message={
          target && (
            <div className="space-y-3">
              <p>{s.suppressionsDelistBody.replace('{email}', target.email)}</p>
              {target.reason === 'COMPLAINT' && (
                <>
                  <p className="rounded-md bg-amber-50 dark:bg-amber-950/40 p-2 text-amber-800 dark:text-amber-300" data-testid="email-suppression-complaint-warning">
                    {s.suppressionsDelistComplaint}
                  </p>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} data-testid="email-suppression-understood" />
                    {s.suppressionsDelistConfirmComplaint}
                  </label>
                </>
              )}
              <label className="block text-sm">
                <span className="text-gray-600 dark:text-gray-400">{s.suppressionsDelistReason}</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  maxLength={500}
                  data-testid="email-suppression-reason"
                  className="mt-1 block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm"
                />
              </label>
            </div>
          )
        }
        confirmLabel={s.suppressionsDelist}
        cancelLabel={t.common.cancel}
        variant="danger"
        loading={busy}
        confirmDisabled={!canDelist}
        onConfirm={() => void delist()}
        onCancel={close}
      />
    </div>
  );
}
