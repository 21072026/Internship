'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useModalFocus } from '@/components/ui/useModalFocus';
import { useLocale, useT } from '@/i18n/client';
import { formatDateTimeWithZone } from '@/lib/relativeTime';
import { viewerTimeZone } from '@/lib/timezone';
import { OUTBOUND_TRIGGERS } from '@/lib/outboundApprovalRule';

// The outbox (#2960): automated mail to leads and customers that the org holds
// for approval. One component for both doors — /admin/outbox (every draft of
// the org) and /sales/outbox (a rep's own leads) — because the API decides the
// scope; this only renders what it is given.
//
// The preview renders the mail's HTML in an iframe with `srcdoc` and an EMPTY
// `sandbox` attribute: no scripts, no same-origin, no forms, no top navigation.
// A held mail is our own template, but it carries a lead's or a colleague's
// words, and the preview must never be the place they run.

type Status = 'DRAFT' | 'SCHEDULED' | 'SENT' | 'DISCARDED' | 'EXPIRED';
const STATUS_TABS = ['DRAFT', 'SCHEDULED', 'SENT', 'DISCARDED', 'EXPIRED', 'ALL'] as const;

interface DraftRow {
  id: string;
  status: Status;
  category: string | null;
  trigger: string;
  reason: string;
  lane: string;
  subject: string | null;
  recipientName: string | null;
  recipientMasked: string | null;
  createdAt: string;
  notAfter: string;
  scheduledFor: string | null;
  decidedAt: string | null;
}

interface DraftDetail extends DraftRow {
  to: string | null;
  html: string | null;
  text: string | null;
}

/** The next 09:00 in the viewer's own clock, as a `datetime-local` value. */
function suggestedLocalValue(now = new Date()): string {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function OutboxPanel() {
  const t = useT();
  const o = t.outbox as Record<string, string>;
  const locale = useLocale();
  const [status, setStatus] = useState<(typeof STATUS_TABS)[number]>('DRAFT');
  const [trigger, setTrigger] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [total, setTotal] = useState(0);
  const [approvalOn, setApprovalOn] = useState<boolean | null>(null);
  const [scope, setScope] = useState<'org' | 'own'>('org');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DraftDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  // What the schedule / discard dialogs act on: one draft or the selection.
  const [scheduleFor, setScheduleFor] = useState<string[] | null>(null);
  const [scheduleValue, setScheduleValue] = useState('');
  const [discardFor, setDiscardFor] = useState<string[] | null>(null);
  const [tz, setTz] = useState('');

  useEffect(() => setTz(viewerTimeZone()), []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({ status });
      if (trigger) params.set('trigger', trigger);
      const res = await fetch(`/api/admin/outbox?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setRows(data.drafts ?? []);
      setTotal(data.total ?? 0);
      setApprovalOn(!!data.approvalOn);
      setScope(data.scope === 'own' ? 'own' : 'org');
      setSelected(new Set());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [status, trigger]);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingIds = useMemo(() => rows.filter((r) => r.status === 'DRAFT').map((r) => r.id), [rows]);
  const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

  const errorText = (code: string | undefined) => (code && o[`error_${code === 'conflict' ? 'not_pending' : code}`]) || o.failed;

  async function act(ids: string[], action: 'send' | 'schedule' | 'discard', at?: string) {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      if (ids.length === 1) {
        const res = await fetch(`/api/admin/outbox/${encodeURIComponent(ids[0])}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(at ? { at } : {}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) setError(errorText(data.code));
        else setFlash(o.done.replace('{n}', '1'));
      } else {
        const res = await fetch('/api/admin/outbox/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ids, ...(at ? { at } : {}) }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) setError(o.failed);
        else {
          const parts = [o.done.replace('{n}', String(data.done?.length ?? 0))];
          if (data.skipped?.length) parts.push(o.skipped.replace('{n}', String(data.skipped.length)));
          setFlash(parts.join(' '));
        }
      }
    } catch {
      setError(o.failed);
    } finally {
      setBusy(false);
      setPreview(null);
      setScheduleFor(null);
      setDiscardFor(null);
      await load();
    }
  }

  async function openPreview(id: string) {
    setPreviewLoading(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/admin/outbox/${encodeURIComponent(id)}`);
      if (res.ok) setPreview((await res.json()).draft);
      else setError(o.failed);
    } catch {
      setError(o.failed);
    } finally {
      setPreviewLoading(false);
    }
  }

  function startSchedule(ids: string[]) {
    setScheduleValue(suggestedLocalValue());
    setScheduleFor(ids);
  }

  function confirmSchedule() {
    if (!scheduleFor) return;
    const when = new Date(scheduleValue);
    if (!scheduleValue || !Number.isFinite(when.getTime())) {
      setError(o.error_schedule_in_past);
      return;
    }
    void act(scheduleFor, 'schedule', when.toISOString());
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedIds = [...selected].filter((id) => pendingIds.includes(id));

  return (
    <div className="space-y-4" data-testid="outbox-panel">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{o.title}</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{o.intro}</p>
      </div>

      {approvalOn !== null && (
        <div
          data-testid="outbox-approval-state"
          data-on={approvalOn ? 'true' : 'false'}
          className={`rounded-lg border px-4 py-3 text-sm ${
            approvalOn
              ? 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-100'
              : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100'
          }`}
        >
          {approvalOn ? o.approvalOn : o.approvalOff}
          {scope === 'own' && <span className="block mt-1">{o.repScope}</span>}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-gray-700 dark:text-gray-300 mb-1">{o.statusFilter}</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as (typeof STATUS_TABS)[number])}
            className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
            data-testid="outbox-status-filter"
          >
            {STATUS_TABS.map((s) => (
              <option key={s} value={s}>
                {o[`status${s}`]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-gray-700 dark:text-gray-300 mb-1">{o.typeFilter}</span>
          <select
            value={trigger}
            onChange={(e) => setTrigger(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-800 px-3 py-2 text-sm"
            data-testid="outbox-type-filter"
          >
            <option value="">{o.allTypes}</option>
            {OUTBOUND_TRIGGERS.map((k) => (
              <option key={k} value={k}>
                {o[`trigger_${k}`]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {(flash || error) && (
        <p
          role="status"
          data-testid="outbox-flash"
          className={`text-sm ${error ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
        >
          {error ?? flash}
        </p>
      )}

      {pendingIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="outbox-bulk-bar">
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(pendingIds))}
              data-testid="outbox-select-all"
            />
            {o.selectAll}
          </label>
          {selectedIds.length > 0 && (
            <>
              <span className="text-sm text-gray-500 dark:text-gray-400" data-testid="outbox-selected-count">
                {o.selected.replace('{n}', String(selectedIds.length))}
              </span>
              <Button size="sm" disabled={busy} onClick={() => void act(selectedIds, 'send')} data-testid="outbox-bulk-send">
                {o.bulkSend}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => startSchedule(selectedIds)} data-testid="outbox-bulk-schedule">
                {o.bulkSchedule}
              </Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => setDiscardFor(selectedIds)} data-testid="outbox-bulk-discard">
                {o.bulkDiscard}
              </Button>
            </>
          )}
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="p-4">
            <SkeletonRows rows={3} />
          </div>
        ) : loadError ? (
          <p className="p-6 text-sm text-red-700 dark:text-red-300" data-testid="outbox-load-error">
            {o.loadFailed}
          </p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-gray-500 dark:text-gray-400" data-testid="outbox-empty">
            {status === 'DRAFT' && !trigger ? o.empty : o.emptyFiltered}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800" data-testid="outbox-list" aria-label={o.title}>
            {rows.map((r) => (
              <li key={r.id} className="p-4 flex flex-col gap-3 md:flex-row md:items-start" data-testid={`outbox-row-${r.id}`}>
                {r.status === 'DRAFT' && (
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={o.selectOne}
                    data-testid={`outbox-select-${r.id}`}
                  />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium text-gray-900 dark:text-gray-100 break-words" data-testid="outbox-subject">
                    {r.subject ?? '—'}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 break-words">
                    <span className="sr-only">{o.recipient}: </span>
                    {r.recipientName ? `${r.recipientName} · ` : ''}
                    <span data-testid="outbox-recipient-masked">{r.recipientMasked ?? '—'}</span>
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <Badge variant="info" data-testid="outbox-trigger">{o[`trigger_${r.trigger}`] ?? o.trigger_other}</Badge>
                    <span>{o[`reason_${r.reason}`] ?? ''}</span>
                    <span>
                      {o.held}: <RelativeTime date={r.createdAt} />
                    </span>
                    {r.status === 'DRAFT' && (
                      <span>
                        {o.expires}: {formatDateTimeWithZone(r.notAfter, locale, tz || undefined)}
                      </span>
                    )}
                    {r.scheduledFor && (
                      <span data-testid="outbox-scheduled-for">
                        {o.scheduledFor}: {formatDateTimeWithZone(r.scheduledFor, locale, tz || undefined)}
                      </span>
                    )}
                    {r.status !== 'DRAFT' && <Badge variant="default">{o[`status${r.status}`]}</Badge>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 md:justify-end">
                  {r.status === 'DRAFT' && (
                    <Button size="sm" variant="secondary" onClick={() => void openPreview(r.id)} data-testid={`outbox-preview-${r.id}`}>
                      {o.preview}
                    </Button>
                  )}
                  {r.status === 'DRAFT' && (
                    <>
                      <Button size="sm" disabled={busy} onClick={() => void act([r.id], 'send')} data-testid={`outbox-send-${r.id}`}>
                        {o.sendNow}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={busy} onClick={() => startSchedule([r.id])} data-testid={`outbox-schedule-${r.id}`}>
                        {o.schedule}
                      </Button>
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => setDiscardFor([r.id])} data-testid={`outbox-discard-${r.id}`}>
                        {o.discard}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {total > rows.length && <p className="text-xs text-gray-500 dark:text-gray-400">{rows.length} / {total}</p>}

      {(preview || previewLoading) && (
        <PreviewDialog
          draft={preview}
          loading={previewLoading}
          labels={o}
          busy={busy}
          onClose={() => setPreview(null)}
          onSend={(id) => void act([id], 'send')}
          onSchedule={(id) => startSchedule([id])}
          onDiscard={(id) => setDiscardFor([id])}
        />
      )}

      {scheduleFor && (
        <ScheduleDialog
          labels={o}
          value={scheduleValue}
          tz={tz}
          busy={busy}
          onChange={setScheduleValue}
          onCancel={() => setScheduleFor(null)}
          onConfirm={confirmSchedule}
        />
      )}

      <ConfirmDialog
        open={!!discardFor}
        message={discardFor && discardFor.length > 1 ? o.confirmDiscardMany.replace('{n}', String(discardFor.length)) : o.confirmDiscard}
        confirmLabel={o.discard}
        cancelLabel={o.cancel}
        variant="danger"
        loading={busy}
        onConfirm={() => discardFor && void act(discardFor, 'discard')}
        onCancel={() => setDiscardFor(null)}
      />
    </div>
  );
}

function PreviewDialog({
  draft,
  loading,
  labels: o,
  busy,
  onClose,
  onSend,
  onSchedule,
  onDiscard,
}: {
  draft: DraftDetail | null;
  loading: boolean;
  labels: Record<string, string>;
  busy: boolean;
  onClose: () => void;
  onSend: (id: string) => void;
  onSchedule: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, onClose);
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 p-2 sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="outbox-preview-title"
        tabIndex={-1}
        data-testid="outbox-preview"
        className="flex w-full max-w-3xl max-h-[92vh] flex-col rounded-lg bg-white dark:bg-gray-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 dark:border-gray-800 p-4">
          <div className="min-w-0">
            <h2 id="outbox-preview-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {o.previewTitle}
            </h2>
            {draft && (
              <dl className="mt-1 text-sm text-gray-600 dark:text-gray-400 break-words">
                <div>
                  <dt className="inline font-medium">{o.previewTo}: </dt>
                  <dd className="inline" data-testid="outbox-preview-to">{draft.to ?? draft.recipientMasked ?? '—'}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">{o.subject}: </dt>
                  <dd className="inline" data-testid="outbox-preview-subject">{draft.subject ?? '—'}</dd>
                </div>
              </dl>
            )}
          </div>
          <Button size="sm" variant="secondary" onClick={onClose} data-testid="outbox-preview-close">
            {o.closePreview}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-4">
          {loading || !draft ? (
            <SkeletonRows rows={4} />
          ) : draft.html ? (
            <iframe
              title={o.previewTitle}
              // EMPTY sandbox: no scripts, no same-origin, no forms, no navigation.
              sandbox=""
              srcDoc={draft.html}
              referrerPolicy="no-referrer"
              className="h-[60vh] w-full rounded border border-gray-200 bg-white dark:border-gray-700"
              data-testid="outbox-preview-frame"
            />
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">{o.previewUnavailable}</p>
          )}
        </div>
        {draft?.status === 'DRAFT' && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 dark:border-gray-800 p-4">
            <Button variant="danger" disabled={busy} onClick={() => onDiscard(draft.id)} data-testid="outbox-preview-discard">
              {o.discard}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => onSchedule(draft.id)} data-testid="outbox-preview-schedule">
              {o.schedule}
            </Button>
            <Button disabled={busy} onClick={() => onSend(draft.id)} data-testid="outbox-preview-send">
              {o.sendNow}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ScheduleDialog({
  labels: o,
  value,
  tz,
  busy,
  onChange,
  onCancel,
  onConfirm,
}: {
  labels: Record<string, string>;
  value: string;
  tz: string;
  busy: boolean;
  onChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useModalFocus<HTMLDivElement>(true, onCancel);
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="outbox-schedule-title"
        tabIndex={-1}
        data-testid="outbox-schedule-dialog"
        className="w-full max-w-sm rounded-lg bg-white dark:bg-gray-800 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="outbox-schedule-title" className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
          {o.schedule}
        </h2>
        <label htmlFor="outbox-schedule-at" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {o.scheduleAt}
        </label>
        <input
          id="outbox-schedule-at"
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full rounded-lg border border-gray-300 dark:border-gray-700 dark:bg-gray-900 px-3 py-2 text-sm"
          aria-describedby="outbox-schedule-hint"
          data-testid="outbox-schedule-at"
        />
        <p id="outbox-schedule-hint" className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {o.scheduleSuggested} {tz ? o.scheduleTimeZone.replace('{tz}', tz) : ''}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
            {o.cancel}
          </Button>
          <Button type="button" loading={busy} disabled={busy} onClick={onConfirm} data-testid="outbox-schedule-confirm">
            {o.scheduleConfirm}
          </Button>
        </div>
      </div>
    </div>
  );
}
