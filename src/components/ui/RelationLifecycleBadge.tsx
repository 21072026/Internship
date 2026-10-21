'use client';

// The state a pairing is in, as a chip (#1774): live green, paused amber,
// completed blue, every other end grey — with the localized end reason on
// hover. Additive: screens that also want the coarse ACTIVE/COMPLETED keep
// their StatusBadge. Reads the state through effectiveLifecycleState(), so a
// row a legacy writer flipped by `status` alone still renders truthfully.

import { useT } from '@/i18n/client';
import { Badge } from '@/components/ui/Badge';
import { effectiveLifecycleState, type RelationLifecycleState } from '@/lib/relationLifecycle';

const VARIANT: Record<RelationLifecycleState, 'success' | 'warning' | 'info' | 'default'> = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  COMPLETED: 'info',
  ENDED_EARLY: 'default',
  ENDED_REMATCHED: 'default',
  ENDED_REASSIGNED: 'default',
  ENDED_CHURNED: 'default',
};

export function RelationLifecycleBadge({
  relation,
  withReason = false,
  className,
}: {
  relation: { status: string; lifecycleState?: string | null; endReasonCode?: string | null };
  /**
   * Admin screens only. #1801's rule: the reason a pairing ended is never read
   * back to the people it is about — a mentor or mentee screen shows the state.
   */
  withReason?: boolean;
  className?: string;
}) {
  const t = useT();
  const state = effectiveLifecycleState(relation);
  const code = relation.endReasonCode;
  // One code vocabulary, two label sets: the lifecycle endpoint's reasons and
  // the admin transfer's (#2289) — an ended pairing may carry either.
  const reasons = { ...t.changeMentor.reasons, ...t.relationLifecycle.reasons } as Record<string, string>;
  const reason = withReason && code && state !== 'ACTIVE' && state !== 'PAUSED' ? reasons[code] : undefined;
  return (
    <Badge
      variant={VARIANT[state]}
      className={className}
      title={reason}
      data-testid="relation-lifecycle-badge"
      data-state={state}
    >
      {t.relationLifecycle.states[state]}
    </Badge>
  );
}
