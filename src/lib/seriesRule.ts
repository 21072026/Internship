// A recurring meeting's cadence (#2013): interval and end condition, pure and
// dependency-free so `node --test --experimental-strip-types` loads it directly
// (scripts/test/series-rule.test.mjs). src/lib/meetingSeriesOccurrences.ts asks
// it, for every calendar date it walks, "does the rule meet on this date?".
//
// Everything here is CALENDAR DATES, never instants. A "day number" is days
// since 1970-01-01 for a date — the same number in every zone — and the wall
// clock is only attached afterwards, by the zone-aware expansion. That is what
// keeps a biweekly rule from drifting across a DST change: weeks are counted in
// dates, and a date does not move when the clocks do.
//
// THE RULES:
//   - intervalWeeks: the rule meets in weeks 0, n, 2n, … counted from the
//     Monday-starting week that holds the anchor date. 1 (the default) is every
//     week — exactly the pre-#2013 behaviour. Nothing before the anchor date.
//   - untilDate: the last calendar date that may carry an occurrence (inclusive).
//   - maxOccurrences: counted from the anchor date; the Nth meeting's date
//     becomes the effective last date.
//   - Both end conditions may be set; the earlier one wins. Neither = until
//     cancelled.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hard ceiling on how many occurrences a rule may be capped at. */
export const MAX_OCCURRENCES_LIMIT = 200;
/** Accepted intervals: every week up to every 8 weeks. */
export const MAX_INTERVAL_WEEKS = 8;

export interface SeriesCadence {
  intervalWeeks?: number | null;
  anchorDate?: Date | null;
  untilDate?: Date | null;
  maxOccurrences?: number | null;
  /** Fallback anchor when anchorDate is null (rules saved before #2013). */
  createdAt?: Date | null;
}

/** Days since 1970-01-01 of the UTC calendar date of `d`. */
export function dayNumber(d: Date): number {
  return Math.floor(d.getTime() / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday, like Date#getUTCDay (1970-01-01 was a Thursday). */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** Day number of the Monday that starts `day`'s week. */
export function mondayOf(day: number): number {
  return day - ((weekdayOf(day) + 6) % 7);
}

function interval(c: SeriesCadence): number {
  const n = Math.trunc(Number(c.intervalWeeks ?? 1));
  return n >= 1 && n <= MAX_INTERVAL_WEEKS ? n : 1;
}

function anchorDay(c: SeriesCadence): number | null {
  const a = c.anchorDate ?? c.createdAt ?? null;
  return a ? dayNumber(a) : null;
}

/** Is `day` in a meeting week of the rule (weekday aside)? */
export function inCadenceWeek(day: number, c: SeriesCadence): boolean {
  const anchor = anchorDay(c);
  if (anchor === null) return interval(c) === 1;
  if (day < anchor) return false;
  const weeks = Math.floor((mondayOf(day) - mondayOf(anchor)) / 7);
  return weeks % interval(c) === 0;
}

/**
 * The last day number that may carry an occurrence, or null for "until
 * cancelled". `weekdays` are the rule's 0–6 days.
 */
export function lastMeetingDay(weekdays: readonly number[], c: SeriesCadence): number | null {
  const until = c.untilDate ? dayNumber(c.untilDate) : null;
  const max = c.maxOccurrences == null ? null : Math.trunc(Number(c.maxOccurrences));
  if (max === null || !(max >= 1)) return until;
  const anchor = anchorDay(c);
  if (anchor === null || weekdays.length === 0) return until;
  const allowed = new Set(weekdays);
  const capped = Math.min(max, MAX_OCCURRENCES_LIMIT);
  // Bounded: at most `capped` meeting weeks, each at most `interval` weeks apart.
  const horizon = anchor + (capped + 1) * interval(c) * 7;
  let seen = 0;
  for (let day = anchor; day <= horizon; day++) {
    if (!allowed.has(weekdayOf(day)) || !inCadenceWeek(day, c)) continue;
    seen++;
    if (seen === capped) return until === null ? day : Math.min(until, day);
  }
  return until;
}

/** Does the rule meet on `day`? (Weekday, interval week and end condition.) */
export function meetsOn(day: number, weekdays: readonly number[], c: SeriesCadence, last = lastMeetingDay(weekdays, c)): boolean {
  if (!weekdays.includes(weekdayOf(day))) return false;
  if (!inCadenceWeek(day, c)) return false;
  return last === null || day <= last;
}

/** True once the rule can produce nothing on or after `today`'s date. */
export function cadenceEnded(weekdays: readonly number[], c: SeriesCadence, today: Date = new Date()): boolean {
  const last = lastMeetingDay(weekdays, c);
  return last !== null && last < dayNumber(today);
}
