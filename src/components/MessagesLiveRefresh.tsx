'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useRealtime } from '@/hooks/useRealtime';

/**
 * Keeps the (server-rendered) message inbox current (#1464).
 *
 * The inbox is a server component — previews, unread counts and row order all
 * come from the render — so there was no way for it to notice a message that
 * arrived while it was on screen, and coming back from a thread could show the
 * unread badge the thread had just cleared. This listens to the live stream and
 * asks the router to re-render the segment.
 *
 * Rate-limited on purpose: `router.refresh()` re-runs the whole page (which
 * adopts mentorships into conversations and counts unread per thread), so a
 * chatty group must not turn into one full re-render per message.
 */
const MIN_INTERVAL_MS = 1_500;

export function MessagesLiveRefresh() {
  const router = useRouter();
  const lastRefresh = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The stream's first `ready` lands moments after this page rendered, so acting
  // on it would re-render the whole inbox for nothing. A *later* `ready` is a
  // reconnect, which is precisely when something may have happened unobserved.
  const seenReady = useRef(false);

  useRealtime((signal) => {
    if (signal.type === 'notification') return;
    if (signal.type === 'ready' && !seenReady.current) {
      seenReady.current = true;
      return;
    }
    if (document.visibilityState === 'hidden') return;
    const since = Date.now() - lastRefresh.current;
    if (since >= MIN_INTERVAL_MS) {
      lastRefresh.current = Date.now();
      router.refresh();
      return;
    }
    // Inside the window — coalesce into one refresh at the end of it.
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      lastRefresh.current = Date.now();
      router.refresh();
    }, MIN_INTERVAL_MS - since);
  });

  return null;
}
