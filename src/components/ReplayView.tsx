'use client';

import { useEffect, useRef, useState } from 'react';
import 'rrweb-player/dist/style.css';
import type { ReplayEvent } from '@/lib/feedbackReplayRule';

// The rrweb player itself (#3131), for recordings already in memory: the
// admin detail (after fetching the gzip) and the reporter's own preview in the
// feedback panel. Default export so the widget can load it — and rrweb-player
// with its stylesheet — only when someone opens a preview (next/dynamic).

const TAGS = { console: '#dc2626', network: '#d97706', submit: '#2563eb' };

export default function ReplayView({
  events,
  maxWidth = 1000,
  onFailed,
}: {
  events: ReplayEvent[];
  maxWidth?: number;
  onFailed?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | undefined;
    (async () => {
      try {
        const { default: Player } = await import('rrweb-player');
        if (cancelled || !host.current) return;
        const width = Math.min(host.current.clientWidth || 800, maxWidth);
        const player = new Player({
          target: host.current,
          props: {
            events: events as never,
            width,
            height: Math.round(width * 0.56),
            autoPlay: false,
            skipInactive: true,
            tags: TAGS,
          },
        });
        // Svelte 4 components carry $destroy at runtime; the typings omit it.
        destroy = (player as unknown as { $destroy?: () => void }).$destroy?.bind(player);
        setReady(true);
      } catch {
        if (!cancelled) onFailed?.();
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [events, maxWidth, onFailed]);

  // rrweb-player paints its controller white but leaves the button and
  // time-label colour to inheritance, so in dark mode they turned
  // white-on-white. Pinned inline: a text-* utility would be flipped by the
  // dark-mode overrides in globals.css.
  return <div ref={host} className="overflow-hidden" style={{ color: '#1f2937' }} data-ready={ready ? '' : undefined} />;
}
