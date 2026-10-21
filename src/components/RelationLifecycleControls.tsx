'use client';

// Pause / resume / end / reopen a pairing (#1770). The only client of
// POST /api/mentorship/[id]/lifecycle; the server decides who may do what
// (checkLifecycleMove in src/lib/relationLifecycle.ts), so the buttons shown
// here are a convenience, never the check. Mounted on /admin/mentorship (one
// per row) and on /mentor/mentees/[id] (with the history list).

import { useCallback, useEffect, useState } from 'react';
import { useT, useLocale } from '@/i18n/client';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { useModalFocus } from '@/components/ui/useModalFocus';
import {
  LIFECYCLE_END_REASON_CODES,
  REASON_NOTE_REQUIRED_FOR,
  endStateForReason,
  isLifecycleEndReasonCode,
  isTerminal,
  type RelationLifecycleState,
} from '@/lib/relationLifecycle';

type Action = 'pause' | 'end' | 'reopen';

interface LifecycleEvent {
  id: string;
  fromState: string;
  toState: string;
  reasonCode: string | null;
  reasonNote: string | null;
  createdAt: string;
  changedByName: string;
}

export function RelationLifecycleControls({
  relationId,
  state,
  isAdmin,
  menteeName,
  mentorName,
  showHistory = false,
  onChanged,
}: {
  relationId: string;
  /** The effective lifecycle state (effectiveLifecycleState). */
  state: RelationLifecycleState;
  isAdmin: boolean;
  menteeName: string;
  mentorName: string;
  showHistory?: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const L = t.relationLifecycle;
  const [action, setAction] = useState<Action | null>(null);
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState<LifecycleEvent[] | null>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(action !== null, () => setAction(null));

  const loadHistory = useCallback(async () => {
    if (!showHistory) return;
    const res = await fetch(`/api/mentorship/${relationId}/lifecycle`);
    if (res.ok) setEvents((await res.json()).events);
  }, [relationId, showHistory]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory, state]);

  const open = (next: Action) => {
    setReasonCode('');
    setNote('');
    setError('');
    setAction(next);
  };

  const post = async (to: string, body: Record<string, string> = {}) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/mentorship/${relationId}/lifecycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, ...body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(
          data.code === 'illegal_transition'
            ? L.errIllegal
            : data.code === 'lifecycle_conflict'
              ? L.errConflict
              : data.code === 'already_mentored'
                ? L.errAlreadyActive
                : data.code === 'reason_required'
                  ? L.reasonRequired
                  : data.code === 'note_required'
                    ? L.noteRequired
                    : L.errGeneric
        );
        return false;
      }
      setAction(null);
      await onChanged?.();
      await loadHistory();
      return true;
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    const trimmed = note.trim();
    if (action === 'end') {
      // Mirrors the server's refusal so the dialog cannot submit without a
      // reason — the server refuses it all the same.
      if (!isLifecycleEndReasonCode(reasonCode)) return setError(L.reasonRequired);
      if (reasonCode === REASON_NOTE_REQUIRED_FOR && !trimmed) return setError(L.noteRequired);
      await post(endStateForReason(reasonCode), { reasonCode, ...(trimmed ? { reasonNote: trimmed } : {}) });
    } else if (action === 'pause') {
      await post('PAUSED', trimmed ? { reasonNote: trimmed } : {});
    } else if (action === 'reopen') {
      await post('ACTIVE', trimmed ? { reasonNote: trimmed } : {});
    }
  };

  const terminal = isTerminal(state);
  const reasonOptions = LIFECYCLE_END_REASON_CODES.map((code) => ({ value: code, label: L.reasons[code] }));
  const title = action === 'pause' ? L.pauseTitle : action === 'end' ? L.endTitle : L.reopenTitle;
  const hint = action === 'pause' ? L.pauseHint : action === 'end' ? L.endHint : L.reopenHint;

  return (
    <div data-testid={`lifecycle-controls-${relationId}`}>
      <div className="flex flex-col gap-2 w-full sm:w-auto sm:flex-row" role="group" aria-label={L.actions}>
        {state === 'ACTIVE' && (
          <Button variant="outline" size="sm" className="w-full sm:w-auto" data-testid="lifecycle-pause" onClick={() => open('pause')}>
            {L.pause}
          </Button>
        )}
        {state === 'PAUSED' && (
          <Button variant="outline" size="sm" className="w-full sm:w-auto" data-testid="lifecycle-resume" loading={saving} onClick={() => post('ACTIVE')}>
            {L.resume}
          </Button>
        )}
        {!terminal && (
          <Button variant="outline" size="sm" className="w-full sm:w-auto" data-testid="lifecycle-end" onClick={() => open('end')}>
            {L.end}
          </Button>
        )}
        {terminal && isAdmin && (
          <Button variant="outline" size="sm" className="w-full sm:w-auto" data-testid="lifecycle-reopen" onClick={() => open('reopen')}>
            {L.reopen}
          </Button>
        )}
      </div>
      {error && action === null && (
        <p className="mt-2 text-sm text-red-700" role="alert" data-testid="lifecycle-inline-error">
          {error}
        </p>
      )}

      {showHistory && events && (
        <div className="mt-4" data-testid="lifecycle-history">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{L.history}</h3>
          {events.length === 0 ? (
            <p className="text-sm text-gray-500">{L.historyEmpty}</p>
          ) : (
            <ul className="space-y-2">
              {events.map((e) => (
                <li key={e.id} className="text-sm text-gray-600 dark:text-gray-300" data-testid="lifecycle-history-row">
                  <span className="font-medium">
                    {L.states[e.fromState as RelationLifecycleState] ?? e.fromState} →{' '}
                    {L.states[e.toState as RelationLifecycleState] ?? e.toState}
                  </span>
                  {e.reasonCode && isLifecycleEndReasonCode(e.reasonCode) && <span> · {L.reasons[e.reasonCode]}</span>}
                  <span className="text-gray-400"> · {L.by.replace('{name}', e.changedByName)} · </span>
                  <RelativeTime date={e.createdAt} locale={locale} className="text-gray-400" />
                  {e.reasonNote && <p className="text-gray-500 whitespace-pre-wrap">{e.reasonNote}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {action && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="lifecycle-dialog-title"
            tabIndex={-1}
            data-testid="lifecycle-dialog"
            className="bg-white rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto"
          >
            <h2 id="lifecycle-dialog-title" className="text-xl font-bold text-gray-900 mb-2">
              {title}
            </h2>
            <p className="text-sm text-gray-500 mb-4">
              {L.context.replace('{person}', menteeName).replace('{owner}', mentorName)}
            </p>
            <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4">{hint}</p>
            {error && (
              <div data-testid="lifecycle-error" className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}
            <div className="space-y-4">
              {action === 'end' && (
                <Select
                  label={L.reason}
                  required
                  data-testid="lifecycle-reason"
                  options={reasonOptions}
                  placeholder={L.selectReason}
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value)}
                />
              )}
              <div>
                <label htmlFor={`lifecycle-note-${relationId}`} className="block text-sm font-medium text-gray-700 mb-1">
                  {L.note}
                </label>
                <textarea
                  id={`lifecycle-note-${relationId}`}
                  data-testid="lifecycle-note"
                  rows={3}
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={L.notePlaceholder}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-400"
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <Button variant="outline" onClick={() => setAction(null)}>
                {t.common.cancel}
              </Button>
              <Button
                onClick={submit}
                loading={saving}
                // The end dialog cannot submit without a reason.
                disabled={action === 'end' && !reasonCode}
                data-testid="lifecycle-submit"
              >
                {L.confirm}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
