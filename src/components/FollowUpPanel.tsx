'use client';

import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { useToast } from '@/components/ui/Toast';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import {
  NEXT_ACTION_NOTE_MAX,
  isNextActionOverdue,
  isNextActionReminderDue,
  parseNextActionDate,
} from '@/lib/nextActionRule';

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

/**
 * The owner's next action on a record (#2563): a follow-up date and one short
 * line. Owner and ADMIN edit it through PUT /api/mentorship/[id]; it is
 * independent of the stage and of the stage SLA, so nothing here reads either.
 */
export function FollowUpPanel({
  relationId,
  nextActionAt,
  nextActionNote,
  onSaved,
}: {
  relationId: string;
  nextActionAt: string | null | undefined;
  nextActionNote: string | null | undefined;
  onSaved?: () => void | Promise<void>;
}) {
  const t = useT();
  const toast = useToast();
  const [date, setDate] = useState(followUpInputValue(nextActionAt));
  const [note, setNote] = useState(nextActionNote ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDate(followUpInputValue(nextActionAt));
    setNote(nextActionNote ?? '');
  }, [nextActionAt, nextActionNote]);

  const save = async (next: { date: string; note: string }) => {
    setError('');
    if (!parseNextActionDate(next.date).ok) {
      setError(t.followUp.invalidDate);
      return;
    }
    if (next.note.trim().length > NEXT_ACTION_NOTE_MAX) {
      setError(t.followUp.tooLong.replace('{max}', String(NEXT_ACTION_NOTE_MAX)));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/mentorship/${relationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nextActionAt: next.date || null, nextActionNote: next.note || null }),
      });
      if (!res.ok) throw new Error();
      toast(t.followUp.saved);
      await onSaved?.();
    } catch {
      toast(t.followUp.saveError, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-700" data-testid="follow-up-panel">
      <div className="mb-2 flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-gray-500 dark:text-gray-400" />
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{t.followUp.title}</p>
        <FollowUpStatus at={nextActionAt} className="text-xs" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <Input
          id={`follow-up-date-${relationId}`}
          type="date"
          label={t.followUp.date}
          value={date}
          disabled={saving}
          onChange={(e) => setDate(e.target.value)}
          data-testid="follow-up-date"
        />
        <Input
          id={`follow-up-note-${relationId}`}
          label={t.followUp.note}
          placeholder={t.followUp.notePlaceholder}
          value={note}
          maxLength={NEXT_ACTION_NOTE_MAX}
          disabled={saving}
          onChange={(e) => setNote(e.target.value)}
          data-testid="follow-up-note"
        />
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" loading={saving} onClick={() => save({ date, note })} data-testid="follow-up-save">
          {t.followUp.save}
        </Button>
        {(nextActionAt || nextActionNote) && (
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
    </div>
  );
}
