'use client';

import { useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useT, useLocale } from '@/i18n/client';
import { formatDate } from '@/lib/relativeTime';
import { TRIAL_ACTIVE_STAGE_KEY, lostWhileTrialOpen } from '@/lib/trialReminderRule';

// A lead marked lost while its trial still runs (#3813). One predicate,
// lostWhileTrialOpen() (lib/trialReminderRule.ts), feeds both the board chip and
// the lead page notice. Nothing moves on its own: the notice offers "Back to
// trial" — an ordinary stage move through PUT /api/mentorship/[id], so the
// stage history, the owner check and the trial window rules are the usual ones
// (an existing trial end is kept, trialWindowFor()).

type Record = { pipelineStatus: string; status?: string | null; trialEndsAt?: string | null };

function daysLeftText(t: ReturnType<typeof useT>, days: number): string {
  if (days === 0) return t.trialEnd.endsToday;
  if (days === 1) return t.trialEnd.oneDayLeft;
  return t.trialEnd.daysLeft.replace('{d}', String(days));
}

/** The board card's "Still in trial · 9 days left"; nothing for any other card. */
export function LostTrialOpenChip({ record, className }: { record: Record; className?: string }) {
  const t = useT();
  const days = lostWhileTrialOpen(
    { pipelineStatus: record.pipelineStatus, status: record.status ?? 'ACTIVE', trialEndsAt: record.trialEndsAt },
    new Date(),
  );
  if (days === null) return null;
  return (
    <Badge variant="warning" className={className} data-testid="lost-trial-open-chip">
      {t.trialEnd.lostOpenChip} · {daysLeftText(t, days)}
    </Badge>
  );
}

/**
 * The lead page's notice. `canRestore` is the server's answer to "may this
 * viewer move the record" (the owner, the dispatcher, an admin); a colleague's
 * read-only view gets the notice without the button.
 */
export function LostTrialOpenNotice({
  relationId,
  record,
  canRestore,
  onRestored,
}: {
  relationId: string;
  record: Record;
  canRestore: boolean;
  onRestored: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const days = lostWhileTrialOpen(
    { pipelineStatus: record.pipelineStatus, status: record.status, trialEndsAt: record.trialEndsAt },
    new Date(),
  );
  if (days === null || !record.trialEndsAt) return null;

  const restore = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/mentorship/${relationId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipelineStatus: TRIAL_ACTIVE_STAGE_KEY }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast(t.trialEnd.lostOpenRestored, 'success');
      onRestored();
    } catch {
      toast(t.trialEnd.lostOpenError, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40"
      data-testid="lost-trial-open-notice"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">{t.trialEnd.lostOpenTitle}</p>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            {t.trialEnd.lostOpenBody.replace('{date}', formatDate(record.trialEndsAt, locale, { timeZone: 'UTC' }))}{' '}
            <span className="whitespace-nowrap">({daysLeftText(t, days)})</span>
          </p>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{t.trialEnd.lostOpenHint}</p>
          {canRestore && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              loading={busy}
              onClick={restore}
              data-testid="lost-trial-open-restore"
            >
              <RotateCcw className="mr-1.5 h-4 w-4" aria-hidden />
              {t.trialEnd.lostOpenRestore}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
