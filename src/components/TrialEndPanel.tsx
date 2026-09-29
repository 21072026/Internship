'use client';

import { useEffect, useState } from 'react';
import { Hourglass } from 'lucide-react';
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
      {t.trialEnd.daysLeft.replace('{d}', String(days))}
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
    <span className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400" data-testid="trial-end-chip">
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
 */
export function TrialEndPanel({
  relationId,
  pipelineStatus,
  trialStartedAt,
  trialEndsAt,
  canEdit = true,
  onSaved,
}: {
  relationId: string;
  pipelineStatus: string;
  trialStartedAt?: string | null;
  trialEndsAt: string | null | undefined;
  canEdit?: boolean;
  onSaved?: () => void | Promise<void>;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [date, setDate] = useState(inputValue(trialEndsAt));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setDate(inputValue(trialEndsAt)), [trialEndsAt]);

  if (!hasTrialToShow(pipelineStatus, trialEndsAt)) return null;
  const editable = canEdit && isTrialEndEditableStage(pipelineStatus);
  const missing = isTrialMissingEndDate({ pipelineStatus, trialEndsAt });

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
        if (data?.code === 'in_the_past') setError(t.trialEnd.inThePast);
        throw new Error();
      }
      toast(data?.reopened ? t.trialEnd.reopened : t.trialEnd.saved);
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
        {trialEndsAt && (
          <span className="text-sm text-gray-700 dark:text-gray-200" data-testid="trial-end-date">
            {formatDate(trialEndsAt, locale, { timeZone: 'UTC' })}
          </span>
        )}
        <TrialEndStatus pipelineStatus={pipelineStatus} trialEndsAt={trialEndsAt} className="text-xs" />
        {trialStartedAt && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t.trialEnd.started.replace('{date}', formatDate(trialStartedAt, locale, { timeZone: 'UTC' }))}
          </span>
        )}
      </div>
      {missing && <p className="mb-2 text-xs text-red-700 dark:text-red-300" data-testid="trial-end-missing-hint">{t.trialEnd.missingHint}</p>}
      {editable && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-48">
            <Input
              id={`trial-end-date-${relationId}`}
              type="date"
              label={t.trialEnd.date}
              value={date}
              disabled={saving}
              onChange={(e) => setDate(e.target.value)}
              data-testid="trial-end-input"
            />
          </div>
          <Button size="sm" loading={saving} disabled={!date} onClick={save} data-testid="trial-end-save">
            {t.trialEnd.save}
          </Button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
