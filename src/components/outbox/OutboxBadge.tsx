'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

/**
 * How many held mails this person may decide (#2960), for the nav badge.
 * Refetched on navigation, like the admin nav's other queue counts: every
 * decision happens on the outbox page, so a route change covers the moments
 * the number can change. `enabled` is false wherever the outbox link is not in
 * the sidebar, so no other shell pays the request.
 */
export function useOutboxPending(enabled: boolean, pathname: string): number {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/admin/outbox?count=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setPending(typeof d?.pending === 'number' ? d.pending : 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, pathname]);
  return pending;
}

export function OutboxBadge({ count }: { count: number }) {
  const t = useT();
  const label = t.outbox.pendingBadge.replace('{count}', String(count));
  return (
    <span
      data-testid="outbox-badge"
      title={label}
      aria-label={label}
      className="min-w-[18px] h-[18px] px-1 rounded-full bg-amber-700 text-white text-[10px] font-bold flex items-center justify-center dark:!bg-amber-700 dark:!text-white"
    >
      {count > 9 ? '9+' : count}
    </span>
  );
}
