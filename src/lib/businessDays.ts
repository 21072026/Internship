// Business-day SLA arithmetic (#1638). The implementation is plain ESM in
// prisma/business-days.mjs — one file shared by the request path, the admin's
// SLA save and the deploy backfill (Node 20 cannot import TS) — and this module
// only gives it types. Pure: safe in a client component (a deadline preview).

import * as impl from '../../prisma/business-days.mjs';

export type SlaDayMode = 'calendar' | 'business';

/** How a service level of N days becomes a date. */
export interface SlaDayRule {
  mode: SlaDayMode;
  /** JS weekdays, 0 = Sunday. */
  workingDays: readonly number[];
  /** Local `YYYY-MM-DD` dates that are not working days. */
  holidays: ReadonlySet<string> | readonly string[];
  /** IANA zone the weekday and the holidays are judged in. */
  timeZone: string;
}

export const DEFAULT_WORKING_DAYS: readonly number[] = impl.DEFAULT_WORKING_DAYS;

export const addBusinessDays = impl.addBusinessDays as (
  from: Date | number | string,
  days: number,
  rule: { workingDays?: readonly number[]; holidays?: Iterable<string>; timeZone: string },
) => Date;

/** The deadline for `days` of service level from `from`; calendar mode is `from + days × 24h`. */
export const slaDeadline = impl.slaDeadline as (
  from: Date | number | string,
  days: number,
  rule: (Omit<SlaDayRule, 'holidays'> & { holidays?: Iterable<string> }) | null | undefined,
) => Date;

export const parseWorkingDays = impl.parseWorkingDays as (raw: string | null | undefined) => number[];

export const parseHolidayList = impl.parseHolidayList as (text: string) => {
  holidays: { date: string; label: string }[];
  invalidLines: number[];
};

export const zoneOffsetMs = impl.zoneOffsetMs as (instant: Date | number, timeZone: string) => number;
