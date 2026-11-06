import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { resolveInsightsWindow, type InsightsWindow } from '@/lib/portalInsightsWindow';

/**
 * The window `/portal/insights` and `GET /api/portal/insights` read off a query
 * string (#1909) — one parse for the page and the route, so the export always
 * covers the period the screen shows.
 */
export function insightsWindowFrom(params: { get(name: string): string | null }, now = new Date()): InsightsWindow {
  const rawFrom = params.get('from');
  const rawTo = params.get('to');
  return resolveInsightsWindow(
    {
      from: rangeStart(rawFrom),
      to: rangeEnd(rawTo),
      days: params.get('days'),
      rangeAsked: Boolean(rawFrom || rawTo),
    },
    now,
  );
}
