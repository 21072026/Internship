'use client';

import { useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { subscribeRealtimeClient, type RealtimeSignal } from '@/lib/realtimeClient';

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
