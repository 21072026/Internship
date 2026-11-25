'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { useT } from '@/i18n/client';
import { INTERACTION_TYPES, type InteractionType } from '@/lib/interactionTypes';
import { stageAdvanceFrom, useStageAdvanceToast } from '@/components/useStageAdvanceToast';

// Compact "log an interaction" form — admins on the candidate detail screen
// (parity with what a mentor can do, #707) and a sales rep on their lead page
// (#2580). Posts to /api/interactions (ADMIN or the relation's owner) and calls
// onAdded() to refresh the list.
//
// `draft` (#3737, sales lead page only): each new `draft.nonce` opens the form
// with the given type and notes and focuses the notes — nothing is posted until
// the person presses the button. Without it the form behaves as before.
export interface InteractionFormDraft {
  nonce: number;
  type?: InteractionType;
  notes?: string;
  /** Called after the interaction this draft opened is saved; dropped on Cancel or by the next draft. */
  onLogged?: () => unknown;
}

/** `<input type="datetime-local">`'s value for `d` in the browser's own zone. */
export function localDateTimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The local wall time the input holds, as the instant the server stores; a bare day passes through. */
function dateTimeToIso(value: string): string {
  if (!value.includes('T')) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

export function AddInteractionForm({
  relationId,
  onAdded,
  draft,
  addLabel,
}: {
  relationId: string;
  onAdded: () => void;
  draft?: InteractionFormDraft | null;
  /** The closed form's button text; defaults to "+ Log interaction". */
  addLabel?: string;
}) {
  const t = useT();
  const stageAdvanceToast = useStageAdvanceToast();
  const [open, setOpen] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [type, setType] = useState<InteractionType>('Meeting');
  // Date AND time, in the person's own zone (#3901): a log typed as a bare day
  // was stored as UTC midnight and read "01:00" in Berlin, and two logs of one
  // day did not sort in the order they happened. Defaults to now.
  const [date, setDate] = useState(() => localDateTimeValue(new Date()));
  const [subject, setSubject] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The open draft's "after saving" step, if it has one (#3803). Held in a ref:
  // it belongs to this draft only, and Cancel or a newer draft discards it.
  const afterLogged = useRef<(() => unknown) | null>(null);

  const close = () => {
    afterLogged.current = null;
    setOpen(false);
  };

  useEffect(() => {
    if (!draft) return;
    afterLogged.current = draft.onLogged ?? null;
    setDate(localDateTimeValue(new Date()));
    setOpen(true);
    setError(null);
    if (draft.type) setType(draft.type);
    if (draft.notes !== undefined) setNotes(draft.notes);
    // After the form has rendered (it may have been closed a moment ago).
    const id = window.setTimeout(() => notesRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [draft]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!notes.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationId, date: dateTimeToIso(date), subject: subject || undefined, notes, type }),
      });
      if (res.ok) {
        setSubject('');
        setNotes('');
        setType('Meeting');
        const after = afterLogged.current;
        close();
        await after?.();
        onAdded();
        // A first contact moved the lead on (#3746): say so, with an Undo that
        // moves it back through the same stage write path a board drag uses.
        const advance = stageAdvanceFrom(await res.json().catch(() => null));
        if (advance) stageAdvanceToast(relationId, advance, onAdded);
      } else {
        setError(t.logInteraction.failed);
      }
    } catch {
      setError(t.logInteraction.failed);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          // "Now" is when the form opens, not when the page was rendered.
          setDate(localDateTimeValue(new Date()));
          setOpen(true);
        }}
        className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700"
        data-testid="interaction-form-open"
      >
        + {addLabel ?? t.logInteraction.add}
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
      {/* What this form is for, next to the follow-up's own line (#3652): what
          already happened goes here; what comes next goes into the follow-up. */}
      <p className="text-xs text-gray-600 dark:text-gray-400" data-testid="interaction-form-hint">{t.logInteraction.hint}</p>
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-0.5 text-xs text-gray-600 dark:text-gray-400">
          {t.logInteraction.type}
          <select
            value={type}
            onChange={(e) => setType(e.target.value as InteractionType)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
          >
            {INTERACTION_TYPES.map((ty) => (
              <option key={ty} value={ty}>{t.interactionTypes[ty]}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-xs text-gray-600 dark:text-gray-400">
          {t.logInteraction.date}
          <input
            type="datetime-local"
            value={date}
            required
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
            data-testid="interaction-form-date"
          />
        </label>
      </div>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder={t.logInteraction.subject}
        className="w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
      />
      <Textarea
        ref={notesRef}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        maxLength={TEXT_LIMITS.interactionNotes}
        placeholder={t.logInteraction.notes}
        showCounter
      />
      {error && <p className="text-xs text-red-600" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={!notes.trim()}>{t.logInteraction.add}</Button>
        <Button type="button" size="sm" variant="outline" onClick={close}>{t.common.cancel}</Button>
      </div>
    </form>
  );
}
