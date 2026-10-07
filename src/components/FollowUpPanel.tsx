'use client';

import { useEffect, useState } from 'react';
import { CalendarClock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
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
} from '@/lib/nextActionRule';
import { nextStepSuggestions } from '@/lib/nextStepSuggestions';

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
 */
export function FollowUpPanel({
  relationId,
  nextActionAt,
  nextActionNote,
  pipelineStatus,
  onSaved,
}: {
  relationId: string;
  nextActionAt: string | null | undefined;
  nextActionNote: string | null | undefined;
  /** The record's current stage key; without it no suggestions render. */
  pipelineStatus?: string | null;
  onSaved?: () => void | Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const vertical = useVertical();
  const toast = useToast();
  const [date, setDate] = useState(followUpInputValue(nextActionAt));
  const [note, setNote] = useState(nextActionNote ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [aiLines, setAiLines] = useState<string[]>([]);
  const [aiNotice, setAiNotice] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHidden, setAiHidden] = useState(false);

  useEffect(() => {
    setDate(followUpInputValue(nextActionAt));
    setNote(nextActionNote ?? '');
  }, [nextActionAt, nextActionNote]);

  // The catalogue is the internship programme's; a vertical with its own
  // funnel writes its lines by hand, as before.
  const stageLines = vertical === 'INTERNSHIP' ? nextStepSuggestions(locale, pipelineStatus) : [];
  const aiOffered = vertical === 'INTERNSHIP' && !!pipelineStatus && !aiHidden;

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
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" data-testid="follow-up-visibility">
        {t.followUp.visibility}
      </p>
    </div>
  );
}
