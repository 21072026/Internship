'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Hourglass, Info, Lock, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import {
  daysUntilUtcDay,
  isTrialEndEditableStage,
  isTrialMissingEndDate,
  parseTrialEndDate,
  trialEndLockReason,
} from '@/lib/trialReminderRule';

// The trial end on a funnel record (#2553). Every rule here is read from
// lib/trialReminderRule.ts — the same UTC-day arithmetic the reminder ladder
// and the expiry sweep use — so the chip can never disagree with the mail.

/** The stored UTC day as the `YYYY-MM-DD` a date input reads. */
function inputValue(at: string | null | undefined): string {
  return at ? at.slice(0, 10) : '';
}

/** Whether a record has anything trial-shaped to show at all. */
export function hasTrialToShow(pipelineStatus: string | null | undefined, trialEndsAt: string | null | undefined): boolean {
  return isTrialEndEditableStage(pipelineStatus) || !!trialEndsAt;
}

/** "3 days left" / "Ends today" / "Ended", or the red "date missing" badge. */
export function TrialEndStatus({
  pipelineStatus,
  trialEndsAt,
  className,
}: {
  pipelineStatus: string | null | undefined;
  trialEndsAt: string | null | undefined;
  className?: string;
}) {
  const t = useT();
  if (isTrialMissingEndDate({ pipelineStatus, trialEndsAt })) {
    return (
      <Badge variant="danger" className={className} data-testid="trial-end-missing">
        {t.trialEnd.missing}
      </Badge>
    );
  }
  if (!trialEndsAt) return null;
  const days = daysUntilUtcDay(new Date(trialEndsAt), new Date());
  if (days < 0) return <Badge variant="default" className={className} data-testid="trial-end-status">{t.trialEnd.ended}</Badge>;
  if (days === 0) return <Badge variant="danger" className={className} data-testid="trial-end-status">{t.trialEnd.endsToday}</Badge>;
  return (
    <Badge variant={days <= 3 ? 'warning' : 'info'} className={className} data-testid="trial-end-status">
      {days === 1 ? t.trialEnd.oneDayLeft : t.trialEnd.daysLeft.replace('{d}', String(days))}
    </Badge>
  );
}

/** A compact read-only line for board cards: the end day, or the missing-date badge. */
export function TrialEndChip({
  pipelineStatus,
  trialEndsAt,
}: {
  pipelineStatus: string | null | undefined;
  trialEndsAt: string | null | undefined;
}) {
  const t = useT();
  const locale = useLocale();
  if (!isTrialEndEditableStage(pipelineStatus)) return null;
  if (!trialEndsAt) return <TrialEndStatus pipelineStatus={pipelineStatus} trialEndsAt={trialEndsAt} className="text-[10px]" />;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400" title={t.boardLegend.trialEnd} data-testid="trial-end-chip">
      <Hourglass className="h-3 w-3" />
      {t.trialEnd.chip.replace('{date}', formatDate(trialEndsAt, locale, { timeZone: 'UTC' }))}
      <TrialEndStatus pipelineStatus={pipelineStatus} trialEndsAt={trialEndsAt} className="text-[10px]" />
    </span>
  );
}

/**
 * The trial end of one record, with an editor for its owner and ADMIN
 * (PATCH /api/mentorship/[id]/trial). Rendered only for a record that has a
 * trial to show; editable only while it is running or has just run out — the
 * route refuses every other stage, so the form is not offered there.
 *
 * `readFirst` (the sales lead page, #3647 — the follow-up panel's pattern): the
 * date reads as text with an Edit button, the field opens on Edit, Cancel
 * throws the edit away and a successful Save returns to reading with the badge
 * already on the new day. Presentation only: the same PATCH, the same rules.
 * Without it the panel keeps its always-open field (admin candidate page).
 *
 * In readFirst mode `canEdit` is WHO may edit (decided on the server), and the
 * record itself may still forbid it: closed, or outside a trial stage. Then
 * the Edit button's place says so in a short line, and an info button opens
 * the full reason — readable on a phone, never left to a hover. The reason
 * comes from `trialEndLockReason()` only; `stageName` is the tenant's own label.
 */
export function TrialEndPanel({
  relationId,
  pipelineStatus,
  trialStartedAt,
  trialEndsAt,
  canEdit = true,
  readFirst = false,
  status = 'ACTIVE',
  stageName,
  onSaved,
}: {
  relationId: string;
  pipelineStatus: string;
  trialStartedAt?: string | null;
  trialEndsAt: string | null | undefined;
  canEdit?: boolean;
  readFirst?: boolean;
  /** The record's status — a closed record is locked (readFirst only). */
  status?: string;
  /** The current stage as the tenant labels it, for the lock reason. */
  stageName?: string;
  onSaved?: () => void | Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [date, setDate] = useState(inputValue(trialEndsAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The saved day as this panel last knew it: the prop, or what the last
  // successful save wrote — so the badge moves before the page refresh lands.
  const [shownEndsAt, setShownEndsAt] = useState<string | null>(trialEndsAt ?? null);
  const [editing, setEditing] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const reasonId = useId();

  useEffect(() => {
    setDate(inputValue(trialEndsAt));
    setShownEndsAt(trialEndsAt ?? null);
  }, [trialEndsAt]);

  // Leaving the form puts the keyboard back on Edit.
  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    editRef.current?.focus();
  }, [editing]);

  if (!hasTrialToShow(pipelineStatus, shownEndsAt)) return null;
  // readFirst asks the one rule for why it is locked; the legacy mode keeps its stage check.
  const lockReason = readFirst ? trialEndLockReason({ status, pipelineStatus }) : null;
  const editable = canEdit && (readFirst ? lockReason === null : isTrialEndEditableStage(pipelineStatus));
  // The reason is for those who could edit were it not locked; nobody else sees an editor anyway.
  const showLock = readFirst && canEdit && lockReason !== null;
  const missing = isTrialMissingEndDate({ pipelineStatus, trialEndsAt: shownEndsAt });
  // Without readFirst the field is always open, as it always was.
  const formOpen = editable && (!readFirst || editing);

  const startEditing = () => {
    setDate(inputValue(shownEndsAt));
    setError('');
    setEditing(true);
  };
  const cancelEditing = () => {
    setDate(inputValue(shownEndsAt));
    setError('');
    returnFocus.current = true;
    setEditing(false);
  };

  const save = async () => {
    setError('');
    const parsed = parseTrialEndDate(date);
    if (!parsed) {
      setError(t.trialEnd.invalidDate);
      return;
    }
    if (daysUntilUtcDay(parsed, new Date()) < 0) {
      setError(t.trialEnd.inThePast);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/mentorship/${relationId}/trial`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trialEndsAt: date }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Codes with a message of their own get exactly one message (inline),
        // never also the generic toast. A 409 means the record moved under us:
        // reload it so the panel stops showing a stale stage and editor.
        const code: unknown = data?.code;
        if (code === 'in_the_past') {
          setError(t.trialEnd.inThePast);
          return;
        }
        if (code === 'conflict' || code === 'not_in_trial' || code === 'relation_closed') {
          // A toast, not the inline line: the reload may take the record out
          // of a trial stage, and then this panel unmounts with its error.
          toast(code === 'conflict' ? t.trialEnd.conflict : t.trialEnd.notEditable, 'error');
          await onSaved?.();
          return;
        }
        throw new Error();
      }
      toast(data?.reopened ? t.trialEnd.reopened : t.trialEnd.saved);
      setShownEndsAt(`${date}T00:00:00.000Z`);
      if (readFirst) {
        returnFocus.current = true;
        setEditing(false);
      }
      await onSaved?.();
    } catch {
      toast(t.trialEnd.saveError, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`rounded-lg border p-3 ${missing ? 'border-red-200 dark:border-red-800' : 'border-gray-200 dark:border-gray-700'}`}
      data-testid="trial-end-panel"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Hourglass className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t.trialEnd.title}</p>
        {shownEndsAt && (
          <span className="text-sm text-gray-700 dark:text-gray-200" data-testid="trial-end-date">
            {formatDate(shownEndsAt, locale, { timeZone: 'UTC' })}
          </span>
        )}
        <TrialEndStatus pipelineStatus={pipelineStatus} trialEndsAt={shownEndsAt} className="text-xs" />
        {trialStartedAt && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t.trialEnd.started.replace('{date}', formatDate(trialStartedAt, locale, { timeZone: 'UTC' }))}
          </span>
        )}
        {readFirst && editable && !editing && (
          <button
            ref={editRef}
            type="button"
            aria-label={t.trialEnd.editLabel}
            onClick={startEditing}
            data-testid="trial-end-edit"
            className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-blue-300"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
            <span>{t.trialEnd.edit}</span>
          </button>
        )}
        {showLock && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300" data-testid="trial-end-lock">
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{lockReason === 'closed' ? t.trialEnd.lockedShortClosed : t.trialEnd.lockedShortNotInTrial}</span>
            <button
              type="button"
              aria-label={t.trialEnd.lockedInfoLabel}
              aria-expanded={reasonOpen}
              aria-controls={reasonId}
              onClick={() => setReasonOpen((open) => !open)}
              data-testid="trial-end-lock-info"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Info className="h-4 w-4" aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      {showLock && reasonOpen && (
        <p id={reasonId} className="mb-2 text-xs text-gray-700 dark:text-gray-200" data-testid="trial-end-lock-reason">
          {lockReason === 'closed'
            ? t.trialEnd.lockedClosed
            : t.trialEnd.lockedNotInTrial.replace('{stage}', stageName ?? pipelineStatus)}
        </p>
      )}
      {missing && <p className="mb-2 text-xs text-red-700 dark:text-red-300" data-testid="trial-end-missing-hint">{t.trialEnd.missingHint}</p>}
      {formOpen && (
        <div className="flex flex-wrap items-end gap-2" data-testid="trial-end-form">
          <div className="w-48">
            <Input
              id={`trial-end-date-${relationId}`}
              type="date"
              label={t.trialEnd.date}
              value={date}
              disabled={saving}
              autoFocus={readFirst}
              onChange={(e) => setDate(e.target.value)}
              data-testid="trial-end-input"
            />
          </div>
          <Button size="sm" loading={saving} disabled={!date} onClick={save} data-testid="trial-end-save">
            {t.trialEnd.save}
          </Button>
          {readFirst && (
            <Button size="sm" variant="secondary" disabled={saving} onClick={cancelEditing} data-testid="trial-end-cancel">
              {t.trialEnd.cancel}
            </Button>
          )}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
