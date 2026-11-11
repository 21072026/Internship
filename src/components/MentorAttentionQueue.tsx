import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { AttentionItem, AttentionReason } from '@/lib/mentorAttention';
import type { UsageNote } from '@/lib/usageSignals';
import type { Dictionary } from '@/i18n/dictionaries';
import type { Locale } from '@/i18n/config';
import { formatDate } from '@/lib/relativeTime';

const REASON_VARIANT: Record<AttentionReason, 'warning' | 'danger' | 'info' | 'purple'> = {
  inactive: 'warning',
  overdue: 'danger',
  unanswered_question: 'info',
  pending_meeting: 'purple',
  no_open_goal: 'info',
  missing_weekly_reports: 'danger',
  // Amber, not red: an expired trial is a decision waiting to be made, not
  // something already broken.
  trial_expired: 'warning',
  // Red: a running trial with no end date is one nothing will ever remind
  // anybody about (#2553) — the data is broken, not merely waiting.
  trial_no_end_date: 'danger',
  // Red like `overdue`: a date the owner promised themselves has gone by.
  next_action_due: 'danger',
  // Amber: a task waiting to be done, with reminders on the way (#1891).
  evaluation_due: 'warning',
  // Product usage (#2449). Red for a drop — revenue walking away; amber for a
  // trial nobody started using — still a conversation to have.
  usage_drop: 'danger',
  trial_inactive: 'warning',
  // Purple: an opportunity, not a problem — a free account outgrowing its plan (#2846).
  free_quota_exceeded: 'purple',
  // Red: a paying customer is on their way out (#2841).
  cancellation_pending: 'danger',
  // Amber: still a conversation to have, with a date on it (#2843).
  decision_window_closing: 'warning',
  behind_cadence: 'info',
};

// Ranked "needs attention" widget on the mentor dashboard (EPIC: mentor
// attention queue). Hides itself when nothing needs attention.
// `hrefBase` is where an item opens: the mentor's mentee page by default, the
// sales surface's lead page there (#2580).
export function MentorAttentionQueue({
  items,
  dormantCount = 0,
  usage = null,
  t,
  locale = 'en',
  hrefBase = '/mentor/mentees',
}: {
  items: AttentionItem[];
  dormantCount?: number;
  /** The usage signals' footnote (#2449), from getAttentionItems(). */
  usage?: UsageNote | null;
  t: Dictionary;
  /** For the notice-period date (#2841). */
  locale?: Locale;
  hrefBase?: string;
}) {
  // Accounts left out of the usage signals are said out loud even when the
  // queue is otherwise empty — an empty queue must not read as "all fine".
  const usageExcluded = !!usage && (usage.noHistory > 0 || usage.unowned > 0);
  if (items.length === 0 && !usageExcluded) return null;
  const labels = t.mentor.attention;
  const reasonLabel: Record<AttentionReason, string> = {
    inactive: labels.inactive,
    overdue: labels.overdue,
    unanswered_question: labels.unansweredQuestion,
    pending_meeting: labels.pendingMeeting,
    no_open_goal: labels.noOpenGoal,
    missing_weekly_reports: t.weeklyReports.missingAttention,
    trial_expired: labels.trialExpired,
    trial_no_end_date: labels.trialNoEndDate,
    next_action_due: labels.nextActionDue,
    evaluation_due: labels.evaluationDue,
    usage_drop: labels.usageDrop,
    trial_inactive: labels.trialInactive,
    free_quota_exceeded: labels.freeQuotaExceeded,
    cancellation_pending: labels.cancellationPending,
    decision_window_closing: labels.decisionWindowClosing,
    behind_cadence: labels.behindCadence,
  };

  return (
    <Card className="mb-6 border-amber-200 dark:border-amber-800" data-testid="attention-queue">
      <CardHeader>
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          <CardTitle>{labels.title} ({items.length})</CardTitle>
        </div>
      </CardHeader>
      <div className="divide-y divide-gray-50 dark:divide-gray-800">
        {items.map((item) => (
          <Link
            key={item.relationId}
            href={`${hrefBase}/${item.relationId}`}
            className="flex flex-wrap items-center justify-between gap-2 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/60 -mx-2 px-2 rounded-lg transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{item.menteeName}</p>
              {item.daysSinceLastInteraction !== null && item.reasons.includes('inactive') && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {labels.daysAgo.replace('{d}', String(item.daysSinceLastInteraction))}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {item.reasons.map((r) => (
                <Badge key={r} variant={REASON_VARIANT[r]} className="text-xs">
                  {r === 'cancellation_pending' && item.contractEndsAt
                    ? reasonLabel[r].replace('{date}', formatDate(item.contractEndsAt, locale, { timeZone: 'UTC' }))
                    : r === 'decision_window_closing' && item.decisionWindowEndsAt
                      ? reasonLabel[r].replace('{date}', formatDate(item.decisionWindowEndsAt, locale, { timeZone: 'UTC' }))
                      : r === 'behind_cadence' && item.cadence
                        ? reasonLabel[r].replace('{d}', String(item.cadence.daysSince)).replace('{n}', String(item.cadence.intervalDays))
                        : reasonLabel[r]}
                </Badge>
              ))}
            </div>
          </Link>
        ))}
      </div>
      {dormantCount > 0 && (
        <p className="pt-3 text-xs text-gray-500 dark:text-gray-400" data-testid="attention-dormant-note">
          {labels.dormantHidden.replace('{n}', String(dormantCount))}
        </p>
      )}
      {usage && usage.noHistory > 0 && (
        <p className="pt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="attention-usage-no-history">
          {labels.usageNoHistory.replace('{n}', String(usage.noHistory))}
        </p>
      )}
      {usage && usage.unowned > 0 && (
        <p className="pt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="attention-usage-unowned">
          {labels.usageUnowned.replace('{n}', String(usage.unowned))}
        </p>
      )}
      {usage && !usage.feedConnected && items.length > 0 && (
        <p className="pt-1 text-xs text-gray-400 dark:text-gray-500" data-testid="attention-usage-no-feed">
          {labels.usageNoFeed}
        </p>
      )}
    </Card>
  );
}
