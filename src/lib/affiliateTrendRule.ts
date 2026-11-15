// A partner's monthly trend and its earnings per click (docs/affiliate-module.md
// § Trend and earnings per click, #3545) — the pure half. The queries are in
// src/lib/affiliateFunnel.ts, next to the funnel they extend.
//
// PURE and dependency-free: no database, no clock — `now` is an input.
//
// The trend uses the funnel's own definitions (src/lib/affiliateFunnelRule.ts)
// month by month, so a month's column and that month's funnel agree:
//   clicks        — tracked-link clicks on the month's UTC days
//   registrations — customers registered in the month
//   paying        — of those, the ones that paid at least once (a COHORT: a
//                   customer who registered in March and paid in May is in March)

/** Months the trend shows: the current UTC month and the eleven before it. */
export const TREND_MONTHS = 12;

export interface TrendMonth {
  /** `YYYY-MM`, UTC. */
  month: string;
  clicks: number;
  registrations: number;
  paying: number;
}

/** `YYYY-MM` of an instant, in UTC. */
export function monthKey(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** The first instant (UTC) of the oldest month the trend shows. */
export function trendStart(now: Date, months = TREND_MONTHS): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
}

/**
 * The trend, oldest month first, every month present (a month with nothing is
 * zeros, never missing — a gap would read as "no data"). Rows outside the
 * window are ignored.
 */
export function buildTrend(
  now: Date,
  clickDays: { day: Date; clicks: number }[],
  customers: { createdAt: Date; paying: boolean }[],
  months = TREND_MONTHS,
): TrendMonth[] {
  const start = trendStart(now, months);
  const result: TrendMonth[] = [];
  const index = new Map<string, TrendMonth>();
  for (let i = 0; i < months; i += 1) {
    const m: TrendMonth = { month: monthKey(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))), clicks: 0, registrations: 0, paying: 0 };
    result.push(m);
    index.set(m.month, m);
  }
  for (const row of clickDays) {
    const m = index.get(monthKey(row.day));
    if (m) m.clicks += row.clicks;
  }
  for (const c of customers) {
    const m = index.get(monthKey(c.createdAt));
    if (!m) continue;
    m.registrations += 1;
    if (c.paying) m.paying += 1;
  }
  return result;
}

/**
 * Earnings per click: the commission earned in the period divided by the
 * period's clicks, in minor units (cents), rounded. Null when there were no
 * clicks — "0.00 per click" would claim a rate nobody measured. Commission
 * from customers who came through the direct (untracked) link counts too, as
 * the funnel's registrations do; the figure is a guide, not a settlement.
 */
export function earningsPerClick(commissionMinor: number, clicks: number): number | null {
  if (!Number.isFinite(clicks) || clicks <= 0) return null;
  return Math.round(commissionMinor / clicks);
}
