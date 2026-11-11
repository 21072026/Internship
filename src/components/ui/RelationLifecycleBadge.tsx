'use client';

import { Badge } from '@/components/ui/Badge';
import { useT } from '@/i18n/client';
import { effectiveLifecycleState } from '@/lib/relationLifecycle';

// Where a pairing stands (#1774): live = green, paused = amber, completed =
// blue, every other ending (early, re-matched, reassigned, won back) = grey —
// so a paused pair never looks like a live one and an early end never reads as
// a completion. The end reason, when one was recorded, is the tooltip.
// Labels are the dictionary's `relationLifecycle.states` / `.reasons`; the keys
// come from src/lib/relationLifecycle.ts. Additive: screens that also want the
// coarse ACTIVE/COMPLETED status keep their StatusBadge.

const VARIANT = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  COMPLETED: 'info',
} as const;

export function RelationLifecycleBadge({
  relation,
  hideLive = false,
  testId = 'relation-lifecycle-badge',
}: {
  relation: { status: string; lifecycleState?: string | null; endReasonCode?: string | null };
  /** Render nothing for a live, unpaused pairing (where a status badge already says so). */
  hideLive?: boolean;
  testId?: string;
}) {
  const t = useT();
  const L = t.relationLifecycle;
  const state = effectiveLifecycleState(relation);
  if (hideLive && state === 'ACTIVE') return null;
  const reasons = L.reasons as Record<string, string>;
  const reason = relation.endReasonCode ? (reasons[relation.endReasonCode] ?? null) : null;
  return (
    <Badge
      variant={VARIANT[state as keyof typeof VARIANT] ?? 'default'}
      title={reason ?? undefined}
      data-testid={testId}
      data-state={state}
    >
      {L.states[state]}
      {reason && <span className="sr-only"> — {reason}</span>}
    </Badge>
  );
}
