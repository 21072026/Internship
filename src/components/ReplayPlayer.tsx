'use client';

import { useEffect, useRef, useState } from 'react';
import 'rrweb-player/dist/style.css';
import { useT } from '@/i18n/client';
import type { FeedbackContext } from '@/lib/feedbackContext';
import { withTimelineMarks, type ReplayEvent, type TimelineMark } from '@/lib/feedbackReplayRule';

// Plays a bug report's session replay (#3131) in the admin detail. The gzip is
// fetched from the authenticated file route and unpacked in the browser; the
// report's console errors and failed requests become marks on the timeline,
// next to the moment the report was sent. rrweb-player is loaded on demand —
// it is only ever needed on this one screen.

const TAGS = { console: '#dc2626', network: '#d97706', submit: '#2563eb' };

export function ReplayPlayer({ src, context }: { src: string; context: FeedbackContext | null }) {
  const t = useT();
  const a = t.adminReports;
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => void) | undefined;
    (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
        const events = JSON.parse(text) as ReplayEvent[];
        const marks: TimelineMark[] = [
          ...(context?.consoleErrors ?? []).map((e) => ({ tag: 'console' as const, at: Date.parse(e.at), label: e.message })),
          ...(context?.failedRequests ?? []).map((r) => ({ tag: 'network' as const, at: Date.parse(r.at), label: `${r.method} ${r.url} ${r.status}` })),
        ];
        const { default: Player } = await import('rrweb-player');
        if (cancelled || !host.current) return;
        const width = Math.min(host.current.clientWidth || 800, 1000);
        const player = new Player({
          target: host.current,
          props: {
            events: withTimelineMarks(events, marks) as never,
            width,
            height: Math.round(width * 0.56),
            autoPlay: false,
            skipInactive: true,
            tags: TAGS,
          },
        });
        // Svelte 4 components carry $destroy at runtime; the typings omit it.
        destroy = (player as unknown as { $destroy?: () => void }).$destroy?.bind(player);
        setState('ready');
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [src, context]);

  return (
    <div data-testid="report-replay">
      {state === 'loading' && <p className="text-sm text-gray-500">{a.replayLoading}</p>}
      {state === 'failed' && <p className="text-sm text-red-700 dark:text-red-400">{a.replayFailed}</p>}
      <div ref={host} className="overflow-hidden" />
      {state === 'ready' && <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{a.replayLegend}</p>}
    </div>
  );
}
