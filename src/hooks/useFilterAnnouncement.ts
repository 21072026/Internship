'use client';

import { useEffect, useRef } from 'react';
import { useAnnounce } from '@/components/ui/LiveRegion';

/**
 * Announce the outcome of a filter that rewrites the page in place (WCAG 4.1.3).
 *
 * Typing in a search box changes what is on screen without moving focus, so a
 * screen-reader user gets no feedback at all — the classic 4.1.3 failure. This
 * speaks the already-formatted `message` through the app-wide live region.
 *
 * Two rules that make it usable rather than maddening:
 *   - **debounced** (`delay`): a per-keystroke announcement queues one utterance
 *     per letter and the reader is still catching up long after typing stopped;
 *   - **deduplicated**: while a query narrows from "An" to "Ann" the count often
 *     does not change, and repeating "3 results shown" adds nothing.
 *
 * Pass `null` when no filter is active — that clears the memory, so returning to
 * the same query later announces again.
 */
export function useFilterAnnouncement(message: string | null, delay = 700) {
  const announce = useAnnounce();
  const lastAnnounced = useRef<string | null>(null);

  useEffect(() => {
    if (!message) {
      lastAnnounced.current = null;
      return;
    }
    const id = setTimeout(() => {
      if (message === lastAnnounced.current) return;
      lastAnnounced.current = message;
      announce(message);
    }, delay);
    return () => clearTimeout(id);
  }, [message, delay, announce]);
}
