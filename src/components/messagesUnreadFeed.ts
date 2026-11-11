'use client';

// The header's unread-message count, ONE copy per tab (#3593).
//
// ResponsiveShell renders a <MessagesButton> twice — in the mobile top bar and
// in the desktop strip; CSS hides one — and each button fetched
// /api/messages/unread on mount and on every navigation, and kept its own
// count. Every page load paid the request twice. Same fix as the bell's feed
// (notificationFeed.ts, #3573): the count lives here, every button renders the
// same snapshot, and concurrent refreshes share one request.

import { useEffect, useSyncExternalStore } from 'react';
import { subscribeRealtimeClient } from '@/lib/realtimeClient';

let count = 0;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let users = 0;
let stop: (() => void) | null = null;
// The pathname the last refresh was asked for. Both buttons run their
// navigation effect in the same commit; the second one finds the first one's
// request in flight, or — if it already answered — the same pathname here.
let refreshedFor: string | null = null;

function publish(next: number) {
  if (next === count) return;
  count = next;
  for (const l of listeners) l();
}

function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/messages/unread', { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();
      publish(d.count ?? 0);
    } catch {
      /* a failed refresh keeps the last count; the stream or the next navigation corrects it */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Re-check on navigation (e.g. after opening a thread and reading it). The
 * stream reports the same drop, but only this covers the polling fallback,
 * where the badge would otherwise hold a stale number until the next tick.
 */
function refreshFor(pathname: string) {
  if (refreshedFor === pathname) return;
  refreshedFor = pathname;
  void load();
}

function start() {
  // The live stream (#1464) carries the count in both directions, so a read
  // thread clears the badge at once instead of a minute later.
  return subscribeRealtimeClient((signal) => {
    if (signal.type === 'ready' || signal.type === 'unread') publish(signal.counts.messages);
  });
}

/**
 * The shared count. `active` is false until the session is authenticated, so a
 * signed-out button starts nothing; `pathname` is the current route, and a new
 * one asks the server once however many buttons are mounted.
 */
export function useMessagesUnread(active: boolean, pathname: string): number {
  useEffect(() => {
    if (!active) return;
    users += 1;
    if (users === 1) stop = start();
    return () => {
      users -= 1;
      if (users === 0) {
        stop?.();
        stop = null;
        // Signed out (or every button unmounted): forget the count, so the next
        // person to sign in on this tab never sees the previous one's badge.
        resetMessagesUnreadForTests();
        for (const l of listeners) l();
      }
    };
  }, [active]);

  useEffect(() => {
    if (active) refreshFor(pathname);
  }, [active, pathname]);

  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => count,
    () => 0,
  );
}

/** Forget everything (the last button stopped, or a test). */
export function resetMessagesUnreadForTests() {
  count = 0;
  inflight = null;
  refreshedFor = null;
}
