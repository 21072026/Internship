'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Pencil, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { AiBadge } from '@/components/AiBadge';
import { useToast } from '@/components/ui/Toast';
import { useT, useLocale } from '@/i18n/client';
import { useVertical } from '@/lib/verticalClient';
import { formatDate } from '@/lib/relativeTime';
import {
  NEXT_ACTION_NOTE_MAX,
  isNextActionOverdue,
  isNextActionReminderDue,
  parseNextActionDate,
  parseNextActionTime,
} from '@/lib/nextActionRule';
import { nextStepSuggestions } from '@/lib/nextStepSuggestions';
import { followUpNoteMissing, isHandoffAction, type HandoffAction } from '@/lib/leadHandoffRule';
import { FollowUpFields } from '@/components/FollowUpFields';
import { FollowUpImagePicker, FollowUpImageThumbs, useCurrentFollowUpImages, useFollowUpImageDrafts } from '@/components/FollowUpImages';

/** The stored UTC day as the `YYYY-MM-DD` a date input reads. */
export function followUpInputValue(at: string | null | undefined): string {
  return at ? at.slice(0, 10) : '';
}

/**
 * "Due today" / "Overdue" for a stored follow-up date, by the same UTC-day rule
 * the reminder and the attention queue use (lib/nextActionRule.ts) — so the
 * chip here can never disagree with the bell or the queue.
 */
export function FollowUpStatus({ at, className }: { at: string | null | undefined; className?: string }) {
  const t = useT();
  if (!at) return null;
  const date = new Date(at);
  const now = Date.now();
  if (isNextActionOverdue(date, now)) {
    return <Badge variant="danger" className={className} data-testid="follow-up-status">{t.followUp.overdue}</Badge>;
  }
  if (isNextActionReminderDue({ nextActionAt: date, nextActionRemindedAt: null }, now)) {
    return <Badge variant="warning" className={className} data-testid="follow-up-status">{t.followUp.dueToday}</Badge>;
  }
  return null;
}

/** A compact read-only "Follow-up 03/12/2026" line for board cards. */
export function FollowUpChip({ at }: { at: string | null | undefined }) {
  const t = useT();
  const locale = useLocale();
  if (!at) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400" data-testid="follow-up-chip">
      <CalendarClock className="h-3 w-3" />
      {t.followUp.chip.replace('{date}', formatDate(at, locale, { timeZone: 'UTC' }))}
      <FollowUpStatus at={at} className="text-[10px]" />
    </span>
  );
}

const CHIP_CLASS =
  'rounded-full border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:border-blue-400 hover:text-blue-700 ' +
  'dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-blue-400 dark:hover:text-blue-300 disabled:opacity-50';

/**
 * The owner's next action on a record (#2563): a follow-up date and one short
 * line. Owner and ADMIN edit it through PUT /api/mentorship/[id]; it is
 * independent of the stage and of the stage SLA, so nothing here reads the
 * stage for the DATE. The stage is read for one thing only (#2875): the
 * ready-made lines offered under the field, and the AI proposal next to them.
 * Both only fill the input — the owner still presses Save.
 *
 * Read mode first (#3647): a saved follow-up reads as a note — the day (with
 * its weekday, red when overdue, amber on the day) and the next step as plain
 * text — and the form opens only on Edit. Cancel throws the edits away, a
 * successful Save, Clear or Complete returns to reading. With nothing saved the
 * panel says so and offers "Add follow-up". Presentation only: the same PUT,
 * the same rules, the same suggestions and quick dates inside the form.
 */
export { localDayFromToday } from '@/components/FollowUpFields';

export function FollowUpPanel({
  relationId,
  nextActionAt,
  nextActionNote,
  nextActionTime,
  pipelineStatus,
  onSaved,
  quickDates = false,
  onComplete,
  readOnly = false,
  actionPicks = false,
  nextActionType = null,
  images = false,
}: {
  relationId: string;
  nextActionAt: string | null | undefined;
  nextActionNote: string | null | undefined;
  /** Optional time of day, "HH:MM" (#3901); absent where the page does not read it. */
  nextActionTime?: string | null;
  /** The record's current stage key; without it no suggestions render. */
  pipelineStatus?: string | null;
  onSaved?: () => void | Promise<void>;
  /** Offer "Tomorrow · 3 days · 1 week · 2 weeks" next to the date (#3739, sales lead page). */
  quickDates?: boolean;
  /**
   * Offer "Complete follow-up" (#3740): hands the follow-up's note to the caller
   * (the sales lead page opens its interaction form with it) together with
   * `clear`, which the caller runs once the interaction is SAVED (#3803) — so a
   * rep who cancels the form keeps the follow-up. Absent everywhere else, so
   * those pages keep only Save / Clear.
   */
  onComplete?: (note: string | null, clear: () => Promise<boolean>) => void;
  /** Reading only (the sales team view, a colleague's record): no edit, add or complete control. */
  readOnly?: boolean;
  /**
   * The sales follow-up (#3903): the same "what is next" picks as the hand-off
   * dialog (FollowUpFields), written as `nextActionType`. The caller passes the
   * note WITHOUT a composed pick label (handoffNoteText), so the words are
   * edited alone and the pick reads in the reader's language.
   */
  actionPicks?: boolean;
  /** The stored pick (#3900); read with `actionPicks` only. */
  nextActionType?: string | null;
  /** Images on the follow-up (#3932): thumbnails when reading, paste / add when editing. */
  images?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const vertical = useVertical();
  const toast = useToast();
  // What is saved, as this panel last knew it: the props, or what the last
  // successful save wrote (so reading mode shows it before the refetch lands).
  const storedType = isHandoffAction(nextActionType) ? nextActionType : null;
  const [shown, setShown] = useState({ at: nextActionAt ?? null, note: nextActionNote ?? null, time: nextActionTime ?? null, type: storedType });
  // A new step starts as a call; a saved one without a pick is free words — `other`.
  const actionFor = (type: HandoffAction | null, note: string | null) => (type ?? (note ? 'other' : 'call'));
  const [action, setAction] = useState<HandoffAction>(actionFor(storedType, nextActionNote ?? null));
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(followUpInputValue(nextActionAt));
  const [time, setTime] = useState(nextActionTime ?? '');
  const [note, setNote] = useState(nextActionNote ?? '');
  const [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [error, setError] = useState('');
  const [aiLines, setAiLines] = useState<string[]>([]);
  const [aiNotice, setAiNotice] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHidden, setAiHidden] = useState(false);
  const current = useCurrentFollowUpImages(relationId, images);
  const drafts = useFollowUpImageDrafts(images && !readOnly ? relationId : null);

  useEffect(() => {
    setShown({ at: nextActionAt ?? null, note: nextActionNote ?? null, time: nextActionTime ?? null, type: storedType });
    setDate(followUpInputValue(nextActionAt));
    setTime(nextActionTime ?? '');
    setNote(nextActionNote ?? '');
    setAction(actionFor(storedType, nextActionNote ?? null));
  }, [nextActionAt, nextActionNote, nextActionTime, storedType]);

  // Leaving the form puts the keyboard back where it came from: on Edit, or on
  // "Add follow-up" once the follow-up was cleared.
  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    (editRef.current ?? addRef.current)?.focus();
  }, [editing, shown]);

  const hasFollowUp = !!(shown.at || shown.note);

  const startEditing = () => {
    setDate(followUpInputValue(shown.at));
    setTime(shown.time ?? '');
    setNote(shown.note ?? '');
    setAction(actionFor(shown.type, shown.note));
    drafts.reset(current.images);
    setError('');
    setEditing(true);
  };

  const cancelEditing = () => {
    setDate(followUpInputValue(shown.at));
    setTime(shown.time ?? '');
    setNote(shown.note ?? '');
    setAction(actionFor(shown.type, shown.note));
    setError('');
    returnFocus.current = true;
    setEditing(false);
  };

  // The catalogue is the internship programme's; a vertical with its own
  // funnel writes its lines by hand, as before.
  const stageLines = vertical === 'INTERNSHIP' ? nextStepSuggestions(locale, pipelineStatus) : [];
  const aiOffered = vertical === 'INTERNSHIP' && !!pipelineStatus && !aiHidden;

  const save = async (
    next: { date: string; note: string; time?: string; action?: HandoffAction | null },
    savedMessage: string = t.followUp.saved,
    // Complete hands the keyboard to the interaction form it opens; it must not be pulled back here.
    // `completed` marks a clear made by Complete, so the history says so (#3819).
    opts: { returnFocus?: boolean; completed?: boolean } = {},
  ): Promise<boolean> => {
    setError('');
    if (!parseNextActionDate(next.date).ok) {
      setError(t.followUp.invalidDate);
      return false;
    }
    // A time belongs to a day: without one it is dropped, not refused.
    const nextTime = next.date ? next.time ?? '' : '';
    if (!parseNextActionTime(nextTime).ok) {
      setError(t.followUp.invalidTime);
      return false;
    }
    // The hand-off's rule (#3903): `other` is the words, so it needs some.
    if (followUpNoteMissing(next.action, next.note)) {
      setError(t.leadHandoff.errors.note_required);
      return false;
    }
    if (next.note.trim().length > NEXT_ACTION_NOTE_MAX) {
      setError(t.followUp.tooLong.replace('{max}', String(NEXT_ACTION_NOTE_MAX)));
      return false;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/mentorship/${relationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nextActionAt: next.date || null,
          nextActionNote: next.note || null,
          nextActionTime: nextTime || null,
          // A cleared step has no pick; the server clears it with the step anyway.
          ...(actionPicks ? { nextActionType: next.date || next.note.trim() ? next.action ?? null : null } : {}),
          // The images the form holds (#3932); a cleared follow-up drops them on the server anyway.
          ...(images && (next.date || next.note.trim()) ? { nextActionImageIds: drafts.ids } : {}),
          ...(opts.completed ? { nextActionCompleted: true } : {}),
        }),
      });
      if (!res.ok) throw new Error();
      toast(savedMessage);
      const cleared = !next.date && !next.note.trim();
      setShown({
        at: next.date || null,
        note: next.note.trim() || null,
        time: nextTime || null,
        type: actionPicks && !cleared ? next.action ?? null : cleared ? null : shown.type,
      });
      if (images) {
        if (cleared) current.setImages([]);
        else await current.reload();
      }
      returnFocus.current = opts.returnFocus ?? true;
      setEditing(false);
      await onSaved?.();
      return true;
    } catch {
      toast(t.followUp.saveError, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Nothing is written on the click: the follow-up stays until the interaction
  // it opens is saved, and Cancel leaves it as it was (#3803).
  const complete = () => {
    onComplete?.(shown.note, () => save({ date: '', note: '' }, t.followUp.completed, { returnFocus: false, completed: true }));
  };

  // One click, one call (#2875): the gate's denials become a line under the
  // chips, and an unconfigured provider hides the button for good.
  const suggestWithAi = async () => {
    setAiLoading(true);
    setAiNotice('');
    try {
      const res = await fetch(`/api/mentorship/${relationId}/next-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        if (body.empty || !Array.isArray(body.suggestions) || body.suggestions.length === 0) setAiNotice(t.followUp.aiEmpty);
        else setAiLines(body.suggestions.filter((s: unknown): s is string => typeof s === 'string'));
      } else if (body.code === 'consent_required') {
        setAiNotice(t.aiSummary.consentRequired);
      } else if (body.code === 'disabled') {
        setAiNotice(t.aiSummary.aiOff);
      } else if (body.code === 'quota_exceeded') {
        setAiNotice(t.aiSummary.quotaExceeded);
      } else if (body.code === 'provider_error') {
        setAiNotice(t.aiSummary.providerError);
      } else if (body.code === 'not_configured') {
        setAiHidden(true);
      } else {
        setAiNotice(t.common.error);
      }
    } catch {
      setAiNotice(t.common.error);
    } finally {
      setAiLoading(false);
    }
  };

  const showSuggestionRow = stageLines.length > 0 || aiOffered;

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="follow-up-panel">
      <div className="mb-2 flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t.followUp.title}</p>
        <FollowUpStatus at={shown.at} className="text-xs" />
        {!readOnly && !editing && hasFollowUp && (
          <button
            ref={editRef}
            type="button"
            aria-label={t.followUp.editLabel}
            onClick={startEditing}
            data-testid="follow-up-edit"
            className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-blue-300"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            <span>{t.followUp.edit}</span>
          </button>
        )}
      </div>
      {!editing && hasFollowUp && (
        <>
          <FollowUpReading at={shown.at} note={shown.note} time={shown.time} type={actionPicks ? shown.type : null} />
          {images && (
            <div className="mt-2">
              <FollowUpImageThumbs images={current.images} testId="follow-up-read-images" />
            </div>
          )}
          {!readOnly && onComplete && (
            <div className="mt-3">
              <Button size="sm" variant="secondary" disabled={saving} title={t.followUp.completeHint} onClick={complete} data-testid="follow-up-complete">
                {t.followUp.complete}
              </Button>
            </div>
          )}
        </>
      )}
      {!editing && !hasFollowUp && (
        <div className="flex flex-wrap items-center justify-between gap-2" data-testid="follow-up-empty">
          <p className="text-sm text-gray-600 dark:text-gray-400">{t.followUp.empty}</p>
          {!readOnly && (
            <Button ref={addRef} type="button" size="sm" variant="outline" className="min-h-11" onClick={startEditing} data-testid="follow-up-add">
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> {t.followUp.add}
            </Button>
          )}
        </div>
      )}
      {!readOnly && editing && (
        <div data-testid="follow-up-form">
          {/* The follow-up is what comes NEXT; what already happened is an interaction (#3652). */}
          <p className="mb-2 text-xs text-gray-600 dark:text-gray-400" data-testid="follow-up-purpose">{t.followUp.purpose}</p>
          <FollowUpFields
            value={{ action: actionPicks ? action : undefined, date, time, note }}
            onChange={(v) => {
              setDate(v.date);
              setTime(v.time);
              setNote(v.note);
              if (v.action) setAction(v.action);
            }}
            idPrefix={`follow-up-${relationId}`}
            testIdPrefix="follow-up"
            actions={actionPicks}
            quickDates={quickDates}
            disabled={saving}
            autoFocus
            images={images ? <FollowUpImagePicker drafts={drafts} testIdPrefix="follow-up" disabled={saving} /> : undefined}
            onPasteImages={images ? (files) => void drafts.add(files) : undefined}
          />
          {showSuggestionRow && (
            <div className="mt-3" data-testid="follow-up-suggestions">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-gray-600 dark:text-gray-300">{t.followUp.suggestionsLabel}</p>
                {aiOffered && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={aiLoading}
                    disabled={saving}
                    title={t.followUp.aiHint}
                    onClick={suggestWithAi}
                    data-testid="follow-up-ai"
                  >
                    <Sparkles className="mr-1 h-4 w-4" /> {t.followUp.aiButton}
                  </Button>
                )}
              </div>
              {stageLines.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {stageLines.map((line) => (
                    <button
                      key={line}
                      type="button"
                      className={CHIP_CLASS}
                      disabled={saving}
                      onClick={() => setNote(line)}
                      data-testid="follow-up-suggestion"
                    >
                      {line}
                    </button>
                  ))}
                </div>
              )}
              {aiLines.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="follow-up-ai-suggestions">
                  <AiBadge className="mr-1" />
                  {aiLines.map((line) => (
                    <button
                      key={line}
                      type="button"
                      className={CHIP_CLASS}
                      disabled={saving}
                      onClick={() => setNote(line)}
                      data-testid="follow-up-ai-suggestion"
                    >
                      {line}
                    </button>
                  ))}
                </div>
              )}
              {aiNotice && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{aiNotice}</p>}
            </div>
          )}
          {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" loading={saving} disabled={drafts.uploading} onClick={() => save({ date, note, time, action: actionPicks ? action : undefined })} data-testid="follow-up-save">
              {t.followUp.save}
            </Button>
            <Button size="sm" variant="secondary" disabled={saving} onClick={cancelEditing} data-testid="follow-up-cancel">
              {t.followUp.cancel}
            </Button>
            {hasFollowUp && (
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => save({ date: '', note: '' })}
                data-testid="follow-up-clear"
              >
                {t.followUp.clear}
              </Button>
            )}
          </div>
          {/* Who reads the note is part of writing it, so it sits with the form only. */}
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="follow-up-visibility">
            {t.followUp.visibility}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The saved follow-up as text: the day with its weekday (in UTC, the day the
 * rule counts), coloured by the same overdue / due-today rule as the chip, and
 * the next step as written.
 */
function FollowUpReading({ at, note, time, type }: { at: string | null; note: string | null; time: string | null; type: HandoffAction | null }) {
  const t = useT();
  const locale = useLocale();
  const now = Date.now();
  const day = at ? new Date(at) : null;
  const tone = !day
    ? 'text-gray-500 dark:text-gray-400'
    : isNextActionOverdue(day, now)
      ? 'font-medium text-red-700 dark:text-red-400'
      : isNextActionReminderDue({ nextActionAt: day, nextActionRemindedAt: null }, now)
        ? 'font-medium text-amber-700 dark:text-amber-400'
        : 'text-gray-800 dark:text-gray-100';
  return (
    <div className="space-y-1" data-testid="follow-up-read">
      <p className={`text-sm ${tone}`} data-testid="follow-up-read-date">
        {day
          ? formatDate(day, locale, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          : t.followUp.noDate}
        {day && time && <span data-testid="follow-up-read-time"> · {time}</span>}
      </p>
      {/* The pick in the reader's language (#3903); `other` says nothing the words do not. */}
      {type && type !== 'other' && (
        <p className="text-sm font-medium text-gray-800 dark:text-gray-100" data-testid="follow-up-read-type">
          {t.leadHandoff.actions[type]}
        </p>
      )}
      <p
        className={`whitespace-pre-wrap break-words text-sm ${note ? 'text-gray-700 dark:text-gray-200' : 'italic text-gray-500 dark:text-gray-400'}`}
        data-testid="follow-up-read-note"
      >
        {note || (type && type !== 'other' ? '' : t.followUp.noNote)}
      </p>
    </div>
  );
}
