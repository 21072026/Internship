// The period a mentee's own activity report covers (#1909, `/portal/insights`).
//
// Two ways to ask: a preset (`?days=1|7|30`, the links on the page) or a date
// range (`?from=&to=`, the same query every other report in the app takes). The
// date strings are parsed by the caller through `rangeStart` / `rangeEnd`
// (src/lib/dateRange.ts — a date-only `to` covers that whole day, #1501); this
// module only decides what to do with the result, so it stays dependency-free
// and unit-testable (scripts/test/portal-insights-window.test.mjs).
//
// The rule, the same parse-and-fall-back shape as the mentor's own report:
// a bad or inverted range never answers 400 or an empty period that reads as
// "you did nothing" — it falls back to the default seven days. A range wins
// over a preset; a missing `to` means now; a missing `from` means seven days
// before `to`.

export const PORTAL_INSIGHTS_DAYS = [1, 7, 30] as const;
export const PORTAL_INSIGHTS_DEFAULT_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InsightsWindowInput {
  /** `rangeStart(from)` — null when absent or unparseable. */
  from: Date | null;
  /** `rangeEnd(to)` — null when absent or unparseable. */
  to: Date | null;
  /** The raw `?days=` value. */
  days: string | null;
  /** Whether the query carried `from` or `to` at all (even unparseable). */
  rangeAsked: boolean;
}

export interface InsightsWindow {
  from: Date;
  to: Date;
  /** The preset in effect, or null for a custom range. */
  days: number | null;
}

function preset(days: number, now: Date): InsightsWindow {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now, days };
}

export function resolveInsightsWindow(input: InsightsWindowInput, now: Date): InsightsWindow {
  if (input.rangeAsked) {
    if (!input.from && !input.to) return preset(PORTAL_INSIGHTS_DEFAULT_DAYS, now);
    const to = input.to ?? now;
    const from = input.from ?? new Date(to.getTime() - PORTAL_INSIGHTS_DEFAULT_DAYS * DAY_MS);
    if (from.getTime() > to.getTime()) return preset(PORTAL_INSIGHTS_DEFAULT_DAYS, now);
    return { from, to, days: null };
  }
  const n = Number(input.days);
  const days = (PORTAL_INSIGHTS_DAYS as readonly number[]).includes(n) ? n : PORTAL_INSIGHTS_DEFAULT_DAYS;
  return preset(days, now);
}

/** `YYYY-MM-DD` for an `<input type="date">` and the export's file name. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
