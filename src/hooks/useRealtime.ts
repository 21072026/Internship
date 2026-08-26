'use client';

import { useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { subscribeRealtimeClient, type RealtimeSignal } from '@/lib/realtimeClient';
import type { UnreadCounts } from '@/lib/unreadCounts';

/**
 * Subscribe a component to the live message stream (#1464).
 *
 * The handler is held in a ref and the effect depends only on the session
 * status, so passing an inline closure (the normal thing to do) neither
 * resubscribes on every render nor needs a `useCallback` at every call site.
 * That matters here beyond tidiness: an effect that re-runs each render would
 * tear the shared `EventSource` down and up again on every keystroke in the
 * composer.
 */
export function useRealtime(handler: (signal: RealtimeSignal) => void) {
  const { status } = useSession();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (status !== 'authenticated') return;
    return subscribeRealtimeClient((signal) => handlerRef.current(signal));
  }, [status]);
}

/**
 * The viewer's two unread counters, kept live. `null` until the first signal
 * arrives, so a badge can render nothing rather than a momentary zero.
 */
export function useUnreadCounts(): UnreadCounts | null {
  const [counts, setCounts] = useState<UnreadCounts | null>(null);
  useRealtime((signal) => {
    if (signal.type === 'ready' || signal.type === 'unread') setCounts(signal.counts);
  });
  return counts;
}
