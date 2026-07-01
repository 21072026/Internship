import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import type { AttentionItem, AttentionReason } from '@/lib/mentorAttention';
import type { Dictionary } from '@/i18n/dictionaries';

const REASON_VARIANT: Record<AttentionReason, 'warning' | 'danger' | 'info' | 'purple'> = {
  inactive: 'warning',
  overdue: 'danger',
  unanswered_question: 'info',
  pending_meeting: 'purple',
};

// Ranked "needs attention" widget on the mentor dashboard (EPIC: mentor
// attention queue). Hides itself when nothing needs attention.
export function MentorAttentionQueue({ items, t }: { items: AttentionItem[]; t: Dictionary }) {
  if (items.length === 0) return null;
  const labels = t.mentor.attention;
  const reasonLabel: Record<AttentionReason, string> = {
    inactive: labels.inactive,
    overdue: labels.overdue,
    unanswered_question: labels.unansweredQuestion,
    pending_meeting: labels.pendingMeeting,
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
            href={`/mentor/mentees/${item.relationId}`}
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
                  {reasonLabel[r]}
                </Badge>
              ))}
            </div>
          </Link>
        ))}
      </div>
    </Card>
  );
}
