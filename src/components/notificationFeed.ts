'use client';

// The notification bell's data, ONE copy per tab (#3573).
//
// ResponsiveShell renders a <NotificationBell> twice — in the mobile top bar
// and in the desktop strip; CSS hides one — and each bell fetched on mount,
// polled every 60 s and re-fetched on every realtime signal. Every page load
// paid /api/notifications twice, and a new row raised its browser
// notification twice. The fetching now lives here: the first mounted bell
// starts the feed, every bell renders the same snapshot, the last one to
// unmount stops it, and concurrent loads share one request.

import { useEffect, useSyncExternalStore } from 'react';
import { subscribeRealtimeClient } from '@/lib/realtimeClient';

export interface FeedNote {
  id: string;
  type: string;
  text?: string | null;
  params?: unknown;
  link?: string | null;
  read: boolean;
  createdAt: string;
}

export interface FeedSnapshot {
  items: FeedNote[];
  unread: number;
}

type NewNoteHandler = (note: FeedNote) => void;

const EMPTY: FeedSnapshot = { items: [], unread: 0 };
const POLL_MS = 60_000;

let snapshot: FeedSnapshot = EMPTY;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let users = 0;
let stop: (() => void) | null = null;
// Ids already accounted for, so a browser notification fires once per new
// row. null until the first load sets the baseline: the unread rows that were
// already there must not raise a burst of popups.
let seenIds: Set<string> | null = null;
let onNewNote: NewNoteHandler | null = null;
// When the last load STARTED. A `tick` (the realtime client's "maybe something
// changed": window focus, a polling round, the tab coming back) inside this
// window is answered by the load that just ran — the window regaining focus
// right after a page load used to fetch the bell a second time.
let lastLoadAt = 0;
const TICK_COALESCE_MS = 10_000;

function publish(next: FeedSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

/** Load the bell's rows once, however many callers ask at the same time. */
export function loadFeed(): Promise<void> {
  if (inflight) return inflight;
  lastLoadAt = Date.now();
  inflight = (async () => {
    try {
      // `view=bell`: the rows and the unread count only, no server-rendered
      // `display`, no total, no type list (the native app and /notifications
      // keep the default shape).
      const res = await fetch('/api/notifications?view=bell');
      if (!res.ok) return;
      const d = await res.json();
      const items: FeedNote[] = d.items ?? [];
      if (seenIds === null) {
        seenIds = new Set(items.map((n) => n.id));
      } else {
        for (const n of items) {
          if (seenIds.has(n.id)) continue;
          seenIds.add(n.id);
          if (!n.read) onNewNote?.(n);
        }
      }
      publish({ items, unread: d.unread ?? 0 });
    } catch {
      /* a failed poll keeps the last snapshot; the next one retries */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The bell marked everything read: reflect it locally until the next load. */
export function markAllReadLocally() {
  publish({ unread: 0, items: snapshot.items.map((n) => ({ ...n, read: true })) });
}

function start() {
  void loadFeed();
  // Kept as a backstop under the live stream (#1464): the stream carries the
  // unread *count*, but the dropdown's rows are fetched, and a run of the
  // hourly crons can create rows with nobody publishing.
  const id = setInterval(() => void loadFeed(), POLL_MS);
  // A new row arrived, or the viewer read a thread and its message.* rows were
  // retired with it (#1464) — either way the bell's contents just changed.
  // A `tick` is only a "maybe": it is coalesced with a load that just ran.
  const unsubscribe = subscribeRealtimeClient((signal) => {
    if (signal.type === 'notification' || signal.type === 'read') void loadFeed();
    else if (signal.type === 'tick' && Date.now() - lastLoadAt >= TICK_COALESCE_MS) void loadFeed();
  });
  return () => {
    clearInterval(id);
    unsubscribe();
  };
}

/**
 * The shared feed. `active` is false until the session is authenticated, so a
 * signed-out bell starts nothing. `onNew` is called once per new unread row,
 * whichever bell registered last — every bell passes the same handler.
 */
export function useNotificationFeed(active: boolean, onNew: NewNoteHandler): FeedSnapshot {
  useEffect(() => {
    onNewNote = onNew;
  }, [onNew]);

  useEffect(() => {
    if (!active) return;
    users += 1;
    if (users === 1) stop = start();
    return () => {
      users -= 1;
      if (users === 0) {
        stop?.();
        stop = null;
        // Signed out (or every bell unmounted): forget the rows and the
        // baseline, so the next person to sign in on this tab never sees the
        // previous one's notifications, not even for a frame.
        resetFeedForTests();
        publish(EMPTY);
      }
    };
  }, [active]);

  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => EMPTY,
  );
}

/** Forget everything (the last bell stopped, or a test). */
export function resetFeedForTests() {
  snapshot = EMPTY;
  seenIds = null;
  inflight = null;
  lastLoadAt = 0;
}
