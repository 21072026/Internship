'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useLocale, useT } from '@/i18n/client';
import type { FeedbackContext } from '@/lib/feedbackContext';
import ReplayView from '@/components/ReplayView';
import {
  formatReplayDuration,
  formatReplaySize,
  replayDurationMs,
  withTimelineMarks,
  type ReplayEvent,
  type TimelineMark,
} from '@/lib/feedbackReplayRule';

// Plays a bug report's session replay (#3131) in the admin detail. The gzip is
// fetched from the authenticated file route and unpacked in the browser; the
// report's console errors and failed requests become marks on the timeline,
// next to the moment the report was sent. The player is ReplayView.

export function ReplayPlayer({ src, context, size, filename }: { src: string; context: FeedbackContext | null; size: number; filename: string }) {
  const t = useT();
  const locale = useLocale();
  const a = t.adminReports;
  const [events, setEvents] = useState<ReplayEvent[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
        const raw = JSON.parse(text) as ReplayEvent[];
        const marks: TimelineMark[] = [
          ...(context?.consoleErrors ?? []).map((e) => ({ tag: 'console' as const, at: Date.parse(e.at), label: e.message })),
          ...(context?.failedRequests ?? []).map((r) => ({ tag: 'network' as const, at: Date.parse(r.at), label: `${r.method} ${r.url} ${r.status}` })),
        ];
        if (!cancelled) {
          setEvents(withTimelineMarks(raw, marks));
          setState('ready');
        }
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, context]);

  return (
    <div data-testid="report-replay">
      {state === 'loading' && <p className="text-sm text-gray-500">{a.replayLoading}</p>}
      {state === 'failed' && <p className="text-sm text-red-700 dark:text-red-400">{a.replayFailed}</p>}
      {events && <ReplayView events={events} onFailed={() => setState('failed')} />}
      {state === 'ready' && <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">{a.replayLegend}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-400">
        <span data-testid="report-replay-meta">
          {a.replayMeta
            .replace('{duration}', events ? formatReplayDuration(replayDurationMs(events)) : '…')
            .replace('{events}', events ? String(events.length) : '…')
            .replace('{size}', formatReplaySize(size, locale))}
        </span>
        <a href={src} download={filename} className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline dark:text-blue-400" data-testid="report-replay-download">
          <Download className="h-3.5 w-3.5" aria-hidden="true" /> {a.replayDownload}
        </a>
        <span>{a.replayNotVideo}</span>
      </div>
    </div>
  );
}
