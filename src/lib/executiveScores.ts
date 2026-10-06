// The executive dashboard's four scores (#1895) — pure and client-safe, so the
// screen can show the exact expression it was computed with and the unit
// tests (scripts/test/executive-scores.test.mjs) pin the arithmetic.
//
// DETERMINISTIC, NEVER PREDICTIVE. Every score is `100 × numerator ÷
// denominator` over records the customer can open, rounded once. Nothing is
// weighted, learned or extrapolated — a sponsor who asks "where does 64 come
// from?" is shown the two counts. No score here may ever be described as a
// prediction (the issue's constraint from the technical review).
//
//   engagement  — relations active in the period with at least one contact in
//                 it (lib/lastContact.ts's rule: a logged interaction, a direct
//                 message either way, or the mentee's own group message)
//                 ÷ relations active in the period
//   progression — relations active in the period that moved FORWARD at least
//                 one on-path stage in it ÷ relations active in the period
//   placement   — relations that FIRST reached the tenant's resolved finished
//                 stage (#1882) in the period ÷ relations active in the period
//   capability  — not measurable yet: it needs skill proficiency over time
//                 (#1822) and the skills-gap report (#1823). Until both exist
//                 the panel says so; no proxy metric stands in for it.

export const EXECUTIVE_SCORE_KEYS = ['engagement', 'progression', 'placement', 'capability'] as const;
export type ExecutiveScoreKey = (typeof EXECUTIVE_SCORE_KEYS)[number];

/** How many periods the trend shows, the current one included. */
export const TREND_PERIODS = 6;

const DAY = 24 * 60 * 60 * 1000;

export interface Period {
  /** Inclusive first day and inclusive last day, YYYY-MM-DD. */
  from: string;
  to: string;
}

/**
 * The selected period and the `count - 1` equally long periods right before
 * it, oldest first. Lengths are whole days, so a 30-day window is compared
 * with the 30 days before it, never with "last month".
 */
export function trendPeriods(from: string, to: string, count = TREND_PERIODS): Period[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const length = Math.round((end - start) / DAY) + 1;
  const out: Period[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const s = start - i * length * DAY;
    out.push({ from: iso(s), to: iso(s + (length - 1) * DAY) });
  }
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 100 × n ÷ d, rounded once (half up); null when there is nothing to divide by. */
export function scoreOf(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((100 * numerator) / denominator);
}

export interface ScorePoint {
  period: Period;
  numerator: number;
  denominator: number;
  score: number | null;
}

/** The expression the info affordance shows, e.g. "100 × 18 ÷ 28 = 64". */
export function expressionOf(p: Pick<ScorePoint, 'numerator' | 'denominator' | 'score'>): string {
  return p.score === null ? `${p.numerator} ÷ ${p.denominator} = n/a` : `100 × ${p.numerator} ÷ ${p.denominator} = ${p.score}`;
}

/** Points the current period moved against the previous one, or null when either is unknown. */
export function deltaOf(points: ScorePoint[]): number | null {
  const current = points.at(-1)?.score ?? null;
  const previous = points.at(-2)?.score ?? null;
  return current === null || previous === null ? null : current - previous;
}

/** Was a relation active at some point in [from, to]? */
export function activeIn(
  r: { startDate: Date; status: string; completedAt: Date | null },
  period: Period,
): boolean {
  const start = Date.parse(`${period.from}T00:00:00Z`);
  const endExclusive = Date.parse(`${period.to}T00:00:00Z`) + DAY;
  if (r.startDate.getTime() >= endExclusive) return false;
  if (r.status === 'ACTIVE') return true;
  // A completed relation counts until the day it completed. One completed
  // before completedAt was recorded has no end date to place it by, so it is
  // left out rather than assumed active forever.
  return r.completedAt !== null && r.completedAt.getTime() >= start;
}

/** Did a stage change move FORWARD on the tenant's on-path order? */
export function isForward(onPath: readonly string[], fromStatus: string, toStatus: string): boolean {
  const from = onPath.indexOf(fromStatus);
  const to = onPath.indexOf(toStatus);
  return from !== -1 && to !== -1 && to > from;
}
