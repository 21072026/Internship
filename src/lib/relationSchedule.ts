// What a pairing agreed to (#1784, story #1782): how long it is meant to run
// and how often the pair means to meet. Pure and client-safe — the creation
// paths, the edit route and the forms all read these rules.
//
//   · `expectedEndDate` — when the pairing is MEANT to finish. Never the same
//     thing as `completedAt` (when it did) or `stageDeadline` (the pipeline
//     stage clock). Stored as a UTC calendar day (midnight UTC).
//   · the meeting rhythm is `expectedMeetingIntervalWeeks` (#2014), the column
//     the cadence figures already read — deliberately not a second cadence in
//     days next to it.
//
// Both are optional everywhere. When the person creating a pairing chooses
// nothing, the programme → org → global settings `relationDefaultDurationMonths`
// / `relationDefaultCadenceWeeks` apply (both '' by default, i.e. nothing).
// Free core: a participant feature, never gated by plan or entitlement.

import { z } from 'zod';

export const DURATION_PRESETS_MONTHS: readonly number[] = [3, 6, 12];
export const CADENCE_PRESETS_WEEKS: readonly number[] = [1, 2, 4];
export const MAX_DURATION_MONTHS = 36;
export const MAX_CADENCE_WEEKS = 52;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day "YYYY-MM-DD" (or a full ISO instant) → midnight UTC of that day; else null. */
export function parseEndDate(raw: string): Date | null {
  const day = raw.slice(0, 10);
  if (!DATE_ONLY.test(day)) return null;
  const d = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day ? null : d;
}

/** `months` calendar months after `from`, as a UTC day; the 31st clamps to the month's last day. */
export function addMonthsUtc(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(from.getUTCDate(), lastDay)));
}

/** The request fields every creation path accepts (all optional). */
export const relationScheduleFields = {
  // An explicit end day wins over a duration.
  expectedEndDate: z.string().max(40).refine((v) => parseEndDate(v) !== null, 'invalid date').nullable().optional(),
  durationMonths: z.number().int().min(1).max(MAX_DURATION_MONTHS).optional(),
  expectedMeetingIntervalWeeks: z.number().int().min(1).max(MAX_CADENCE_WEEKS).nullable().optional(),
};

export interface RelationScheduleInput {
  expectedEndDate?: string | null;
  durationMonths?: number;
  expectedMeetingIntervalWeeks?: number | null;
}

export interface RelationScheduleDefaults {
  durationMonths: number | null;
  cadenceWeeks: number | null;
}

/** A configured default is used only inside the bounds the forms accept. */
export function sanitizeDefaults(raw: { durationMonths: unknown; cadenceWeeks: unknown }): RelationScheduleDefaults {
  const inRange = (v: unknown, max: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : null);
  return { durationMonths: inRange(raw.durationMonths, MAX_DURATION_MONTHS), cadenceWeeks: inRange(raw.cadenceWeeks, MAX_CADENCE_WEEKS) };
}

/**
 * The columns a NEW pairing is created with. What the caller sent wins
 * (an explicit `null` means "none", and the default does not apply); a field
 * the caller left out takes the default. Nothing at all → `{}`, so a pairing
 * created without either is exactly what it was before #1784.
 */
export function scheduleCreateData(
  input: RelationScheduleInput,
  start: Date,
  defaults: RelationScheduleDefaults,
): { expectedEndDate?: Date | null; expectedMeetingIntervalWeeks?: number | null } {
  const out: { expectedEndDate?: Date | null; expectedMeetingIntervalWeeks?: number | null } = {};
  if (input.expectedEndDate !== undefined) {
    out.expectedEndDate = input.expectedEndDate === null ? null : parseEndDate(input.expectedEndDate);
  } else if (input.durationMonths !== undefined) {
    out.expectedEndDate = addMonthsUtc(start, input.durationMonths);
  } else if (defaults.durationMonths) {
    out.expectedEndDate = addMonthsUtc(start, defaults.durationMonths);
  }
  if (input.expectedMeetingIntervalWeeks !== undefined) {
    out.expectedMeetingIntervalWeeks = input.expectedMeetingIntervalWeeks;
  } else if (defaults.cadenceWeeks) {
    out.expectedMeetingIntervalWeeks = defaults.cadenceWeeks;
  }
  return out;
}

/**
 * A pairing that joins a programme takes the programme's defaults for what it
 * has not agreed yet — only for a field that is still empty and that the same
 * request does not set itself. Never overwrites an agreement.
 */
export function scheduleOnProgrammeJoin(
  current: { startDate: Date; expectedEndDate: Date | null; expectedMeetingIntervalWeeks: number | null },
  requested: { expectedEndDate?: unknown; expectedMeetingIntervalWeeks?: unknown },
  defaults: RelationScheduleDefaults,
): { expectedEndDate?: Date; expectedMeetingIntervalWeeks?: number } {
  const out: { expectedEndDate?: Date; expectedMeetingIntervalWeeks?: number } = {};
  if (current.expectedEndDate === null && requested.expectedEndDate === undefined && defaults.durationMonths) {
    out.expectedEndDate = addMonthsUtc(current.startDate, defaults.durationMonths);
  }
  if (current.expectedMeetingIntervalWeeks === null && requested.expectedMeetingIntervalWeeks === undefined && defaults.cadenceWeeks) {
    out.expectedMeetingIntervalWeeks = defaults.cadenceWeeks;
  }
  return out;
}

/** "Every week" / "Every {n} weeks" from a dictionary block. */
export function cadenceLabel(d: { everyWeek: string; everyWeeks: string }, weeks: number): string {
  return (weeks === 1 ? d.everyWeek : d.everyWeeks).replace('{n}', String(weeks));
}

/** "{n} months" from a dictionary block. */
export function monthsLabel(d: { months: string }, months: number): string {
  return d.months.replace('{n}', String(months));
}
