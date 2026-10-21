// What a pair agreed at the match (#1784): how long the pairing is meant to
// run, and how often they mean to meet. Client-safe — no Prisma import — so
// the creation routes, the edit route, the admin form and the unit test read
// the same rules.
//
// Two numbers, two columns, and neither is new for its own sake:
//   · the CADENCE is `MentorshipRelation.expectedMeetingIntervalWeeks` (#2014),
//     the promise src/lib/meetingCadence.ts already measures — set here at the
//     match instead of only afterwards. There is deliberately no second cadence
//     column in days: two cadences would be two answers to "are they on track?"
//   · the LENGTH is `expectedEndDate` — when the pairing is MEANT to finish.
//     `completedAt` is when it actually ended; the two are different facts and
//     different columns. Neither is `stageDeadline`, which is the pipeline
//     STAGE clock with its own reminder.
//
// Both are optional everywhere: a relation created without them is valid and
// every existing row keeps meaning what it meant. Changing the end date by
// hand is an edit, never an extension — `durationExtendedCount` moves only
// through the explicit extend action (#1786).

const DAY_MS = 24 * 60 * 60 * 1000;

/** The duration presets the forms offer, in months. Any 1…MAX is accepted by the API. */
export const DURATION_PRESETS_MONTHS = [3, 6, 12] as const;
export const MAX_DURATION_MONTHS = 60;

/** The cadence presets, in weeks — the same promise RelationCadencePanel edits. */
export const CADENCE_PRESETS_WEEKS = [1, 2, 4] as const;
export const MAX_CADENCE_WEEKS = 52;

/** `start` plus `months` calendar months, UTC, clamped to the target month's last day. */
export function endDateFromDuration(start: Date, months: number): Date {
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), lastDay)));
}

export interface ScheduleInput {
  /** An explicit end date, `YYYY-MM-DD` (or an ISO instant); null clears it. */
  expectedEndDate?: string | null;
  /** A duration in months from the start date — the presets' shape. Ignored when an end date is sent. */
  durationMonths?: number | null;
  /** The promised meeting interval in weeks; null clears it. */
  expectedMeetingIntervalWeeks?: number | null;
}

export type ScheduleResult =
  | { ok: true; data: { expectedEndDate?: Date | null; expectedMeetingIntervalWeeks?: number | null } }
  | { ok: false; code: 'invalid_end_date' | 'end_before_start' | 'end_too_far' | 'invalid_duration' | 'invalid_cadence' };

/**
 * Validate what a caller sent and turn it into column values. Only the keys
 * the caller sent come back, so an absent field never overwrites a stored one.
 */
export function parseSchedule(input: ScheduleInput, start: Date): ScheduleResult {
  const data: { expectedEndDate?: Date | null; expectedMeetingIntervalWeeks?: number | null } = {};

  if (input.expectedEndDate !== undefined) {
    if (input.expectedEndDate === null || input.expectedEndDate === '') {
      data.expectedEndDate = null;
    } else {
      const raw = input.expectedEndDate;
      const at = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : new Date(raw);
      if (Number.isNaN(at.getTime())) return { ok: false, code: 'invalid_end_date' };
      if (at.getTime() <= start.getTime() - DAY_MS) return { ok: false, code: 'end_before_start' };
      if (at.getTime() > endDateFromDuration(start, MAX_DURATION_MONTHS).getTime()) return { ok: false, code: 'end_too_far' };
      data.expectedEndDate = at;
    }
  } else if (input.durationMonths !== undefined && input.durationMonths !== null) {
    const months = input.durationMonths;
    if (!Number.isInteger(months) || months < 1 || months > MAX_DURATION_MONTHS) return { ok: false, code: 'invalid_duration' };
    data.expectedEndDate = endDateFromDuration(start, months);
  }

  if (input.expectedMeetingIntervalWeeks !== undefined) {
    const weeks = input.expectedMeetingIntervalWeeks;
    if (weeks !== null && (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_CADENCE_WEEKS)) {
      return { ok: false, code: 'invalid_cadence' };
    }
    data.expectedMeetingIntervalWeeks = weeks;
  }

  return { ok: true, data };
}
