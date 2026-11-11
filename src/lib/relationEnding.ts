// The end of an agreed pairing, and its rhythm (#1786, story #1782) — pure,
// client-safe and unit-tested (scripts/test/relation-ending.test.mjs).
//
// THE ENDING-SOON NUDGE. A live, unpaused pairing whose `expectedEndDate` is
// within `relationEndingLeadDays` (a setting, default 14) gets ONE nudge, to
// both participants, stamped in `endingSoonNotifiedAt`. Two limits are not
// configurable, the same two docs/dormant-first-contacts.md sets for its own
// nudges, and for the same reason (the sending domain's reputation, and a
// person's own decision about their own pairing):
//   · ONE nudge per end date — no second chase. Only a NEW end date (an
//     extension, or an edit of the date) clears the stamp and earns its own one.
//   · NO automatic closure, and no automatic extension. A pairing past its end
//     date stays exactly as it is until a person ends or extends it.
//
// THE RHYTHM SIGNAL. `cadenceStatus()` compares the gap since the pair last met
// with the rhythm they agreed (`expectedMeetingIntervalWeeks`, #2014):
// `behind` once the gap exceeds the interval × CADENCE_BEHIND_FACTOR. One rule,
// here, deterministic and named for what it measures — never a score, never
// "at risk". No agreed rhythm is `no_data`, which every surface renders as
// nothing at all: most pairs have never agreed one.

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_ENDING_LEAD_DAYS = 14;
export const MAX_ENDING_LEAD_DAYS = 90;
/** "Behind" = the gap since the last meeting is more than 1.5 × the agreed interval. */
export const CADENCE_BEHIND_FACTOR = 1.5;
export const MAX_EXTEND_MONTHS = 24;

/** A configured lead outside 1…MAX reads as the default. */
export function endingLeadDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_ENDING_LEAD_DAYS ? n : DEFAULT_ENDING_LEAD_DAYS;
}

/**
 * Is the ending-soon nudge due for this pairing now? Only for an end date that
 * has not passed by more than a day (a date set in the past is not "soon"), is
 * within the lead window, and has not been nudged.
 */
export function isEndingSoon(
  relation: { expectedEndDate: Date | null; endingSoonNotifiedAt: Date | null },
  now: Date,
  leadDays: number,
): boolean {
  if (!relation.expectedEndDate || relation.endingSoonNotifiedAt) return false;
  const left = relation.expectedEndDate.getTime() - now.getTime();
  return left > -DAY_MS && left <= leadDays * DAY_MS;
}

/** Whole calendar days from `now` to the end date (0 = today, negative = past). */
export function daysUntilEnd(expectedEndDate: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((expectedEndDate.getTime() - today) / DAY_MS);
}

export type CadenceStatus = 'on_track' | 'behind' | 'no_data';

export interface CadenceReading {
  status: CadenceStatus;
  /** The agreed interval in days, when there is one. */
  intervalDays: number | null;
  /** Days since the pair last met — or since the pairing started, if it never met. */
  daysSince: number | null;
}

/**
 * The pair's rhythm against what they agreed. `lastMetAt` null means no
 * meeting in view: the gap is then counted from the pairing's start, so a pair
 * that never met is behind once the start is that far back.
 */
export function cadenceStatus(
  relation: { expectedMeetingIntervalWeeks: number | null; startDate: Date },
  lastMetAt: Date | null,
  now: Date,
): CadenceReading {
  const weeks = relation.expectedMeetingIntervalWeeks;
  if (!weeks || weeks <= 0) return { status: 'no_data', intervalDays: null, daysSince: null };
  const intervalDays = weeks * 7;
  const anchor = lastMetAt ?? relation.startDate;
  const daysSince = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / DAY_MS));
  return { status: daysSince > intervalDays * CADENCE_BEHIND_FACTOR ? 'behind' : 'on_track', intervalDays, daysSince };
}

/**
 * The pairing's original length in whole months (start → agreed end), the
 * "extend by the original duration" of the one-click button. At least 1.
 */
export function originalDurationMonths(startDate: Date, expectedEndDate: Date): number {
  const months =
    (expectedEndDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 + (expectedEndDate.getUTCMonth() - startDate.getUTCMonth());
  return Math.min(MAX_EXTEND_MONTHS, Math.max(1, months));
}
