// Relationship-health history (#1901) — the rules that read the nightly
// snapshots, pure so they are unit-tested without a database: when a pair's
// crossing into AT_RISK earns an admin alert, and what its trend is.
// docs/relationship-health.md § History and alerts.

import type { HealthBand } from './relationHealth';

/** Snapshots older than this are pruned by the sweep that writes them. */
export const SNAPSHOT_RETENTION_DAYS = 180;
/** A pair that stays red is re-alerted no more often than this. */
export const ALERT_REPEAT_DAYS = 30;

const DAY = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day `at` falls in — the snapshot's `takenOn`. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Does today's snapshot earn an alert?
 *
 * ONE ALERT PER CROSSING: a pair that moved into AT_RISK since yesterday is
 * alerted; a pair that stays red is not alerted again the next night — only
 * once it has been ALERT_REPEAT_DAYS since its last alert (or after it
 * recovered and fell again, which is a new crossing).
 *
 * No snapshot yesterday is a BASELINE, not a crossing: the first sweep after
 * deploy (or after a gap) would otherwise mail every pair that is already red,
 * all at once. Those pairs show in the health views; they are alerted when
 * they next cross.
 */
export function shouldAlert(input: {
  today: Date;
  todayBand: HealthBand;
  yesterdayBand: HealthBand | null;
  lastAlertOn: Date | null;
}): boolean {
  if (input.todayBand !== 'AT_RISK') return false;
  if (input.yesterdayBand === null) return false;
  if (input.yesterdayBand !== 'AT_RISK') return true;
  return input.lastAlertOn !== null && input.today.getTime() - input.lastAlertOn.getTime() >= ALERT_REPEAT_DAYS * DAY;
}

export interface TrendPoint {
  day: string; // YYYY-MM-DD
  score: number | null;
  band: HealthBand;
}

export interface HealthTrend {
  series: TrendPoint[];
  /** Today's score minus the score 7 / 30 days ago (null when either is unknown). */
  delta7: number | null;
  delta30: number | null;
}

/**
 * The daily series over the last `days` days (oldest first) and the 7/30-day
 * deltas. A day without a snapshot is simply absent — the series is what was
 * measured, never interpolated. The delta compares against the latest snapshot
 * on or before the target day, so one missed night does not blank it.
 */
export function healthTrendFrom(
  snapshots: { takenOn: Date; score: number | null; band: string }[],
  days: number,
  today: Date,
): HealthTrend {
  const end = utcDay(today).getTime();
  const start = end - (days - 1) * DAY;
  const sorted = [...snapshots].sort((a, b) => a.takenOn.getTime() - b.takenOn.getTime());
  const series = sorted
    .filter((s) => s.takenOn.getTime() >= start && s.takenOn.getTime() <= end)
    .map((s) => ({ day: s.takenOn.toISOString().slice(0, 10), score: s.score, band: s.band as HealthBand }));
  const scoreOnOrBefore = (t: number) => {
    let hit: number | null | undefined;
    for (const s of sorted) if (s.takenOn.getTime() <= t) hit = s.score;
    return hit ?? null;
  };
  const latest = sorted.filter((s) => s.takenOn.getTime() <= end).at(-1);
  const now = latest?.score ?? null;
  const delta = (back: number) => {
    const then = scoreOnOrBefore(end - back * DAY);
    return now === null || then === null ? null : now - then;
  };
  return { series, delta7: delta(7), delta30: delta(30) };
}
