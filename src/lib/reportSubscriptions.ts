// Report subscriptions (#1905) — the rules, pure and client-safe: what a valid
// subscription is, which period a moment belongs to, and whether a
// subscription is due. The sender (src/lib/jobs/reportSubscriptions.ts) and
// the admin API both read them from here, so "due" and "valid" cannot mean two
// different things. docs/report-subscriptions.md.

import { getReportDefinition } from './reports/definitions';

export const CADENCES = ['WEEKLY', 'MONTHLY', 'QUARTERLY'] as const;
export type Cadence = (typeof CADENCES)[number];
export const FORMATS = ['EMAIL_SUMMARY', 'CSV', 'XLSX'] as const;
export type SubscriptionFormat = (typeof FORMATS)[number];
export const SUBSCRIPTION_LOCALES = ['en', 'tr', 'de'] as const;

export const isCadence = (v: unknown): v is Cadence => typeof v === 'string' && (CADENCES as readonly string[]).includes(v);
export const isFormat = (v: unknown): v is SubscriptionFormat => typeof v === 'string' && (FORMATS as readonly string[]).includes(v);

/** The schedule fields the rules read. */
export interface Schedule {
  cadence: string;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  hour: number;
}

export interface SubscriptionInput extends Schedule {
  reportKey: string;
  locale: string;
  format: string;
  recipientUserId?: string | null;
  recipientEmail?: string | null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/**
 * Why this subscription cannot be stored, or null. Checked when it is WRITTEN —
 * an unknown report or an impossible schedule must be refused in front of the
 * admin, not discovered by a job at 07:00 with nobody watching.
 */
export function subscriptionProblem(input: SubscriptionInput): string | null {
  if (!getReportDefinition(input.reportKey)) return 'unknown_report';
  if (!isCadence(input.cadence)) return 'invalid_cadence';
  if (!isFormat(input.format)) return 'invalid_format';
  if (!(SUBSCRIPTION_LOCALES as readonly string[]).includes(input.locale)) return 'invalid_locale';
  if (!int(input.hour, 0, 23)) return 'invalid_hour';
  if (input.cadence === 'WEEKLY' && !int(input.dayOfWeek, 1, 7)) return 'invalid_day';
  // 1–28 so the day exists in every month, February included.
  if (input.cadence !== 'WEEKLY' && !int(input.dayOfMonth, 1, 28)) return 'invalid_day';
  const hasUser = !!input.recipientUserId;
  const hasEmail = !!input.recipientEmail;
  if (hasUser === hasEmail) return 'one_recipient';
  if (hasEmail && (!EMAIL_RE.test(input.recipientEmail!) || input.recipientEmail!.length > 320)) return 'invalid_email';
  return null;
}

/** ISO 8601 weekday of a UTC moment: 1 = Monday … 7 = Sunday. */
export function isoWeekday(d: Date): number {
  return ((d.getUTCDay() + 6) % 7) + 1;
}

/** ISO week-numbering year and week of a UTC moment. */
export function isoWeek(d: Date): { year: number; week: number } {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // The Thursday of this week decides the year.
  day.setUTCDate(day.getUTCDate() + 4 - isoWeekday(day));
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return { year: day.getUTCFullYear(), week: Math.ceil(((day.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7) };
}

/**
 * The period a moment falls in, as the idempotency key: one send per
 * subscription per period, whatever happens to the job in between.
 */
export function periodKey(cadence: Cadence, now: Date): string {
  if (cadence === 'WEEKLY') {
    const { year, week } = isoWeek(now);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }
  const month = now.getUTCMonth() + 1;
  if (cadence === 'MONTHLY') return `${now.getUTCFullYear()}-${String(month).padStart(2, '0')}`;
  return `${now.getUTCFullYear()}-Q${Math.ceil(month / 3)}`;
}

/**
 * Is this subscription due at `now`? True from its hour on its day until the
 * end of that day — so a job that missed the exact hour (a deploy, a restart)
 * still sends that day, and the period key keeps it to one send.
 */
export function isDue(s: Schedule, now: Date): boolean {
  if (!isCadence(s.cadence)) return false;
  if (now.getUTCHours() < s.hour) return false;
  if (s.cadence === 'WEEKLY') return isoWeekday(now) === s.dayOfWeek;
  if (now.getUTCDate() !== s.dayOfMonth) return false;
  // QUARTERLY: the first month of each quarter.
  return s.cadence === 'MONTHLY' || now.getUTCMonth() % 3 === 0;
}
