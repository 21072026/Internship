// A mentor's booking guardrails (#2003) — pure and client-safe. The rows are
// read in src/lib/bookingPolicy.ts; this file only judges a candidate booking
// against them, so the boundaries are unit-tested
// (scripts/test/booking-policy.test.mjs).
//
// The failure these prevent is the one that ends volunteer programmes: the most
// generous mentors get swamped, burn out and go quiet. So the mentor draws the
// line once — notice, caps, a gap between calls, a session length — and the
// product holds it on every write path.
//
// Week and month are the MENTOR's: a week starts Monday 00:00 and a month on
// the 1st at 00:00 in their own zone, never in UTC. "Three a week" means the
// week they live in.

import { parseWallClockInZone, resolveTimeZone } from '@/lib/timezone';
import { dateInZone, weekdayInZone } from '@/lib/availabilitySlots';
import { overlaps, type Window } from '@/lib/busyWindowsRule';

export interface BookingPolicy {
  minNoticeMinutes: number | null;
  bufferMinutes: number | null;
  maxPerWeek: number | null;
  maxPerMonth: number | null;
  defaultSlotMinutes: number | null;
}

export const POLICY_RULES = ['min_notice', 'buffer', 'weekly_cap', 'monthly_cap'] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

export interface PolicyViolation {
  rule: PolicyRule;
  /** The number the mentor set — minutes for notice/buffer, a count for caps. */
  limit: number;
  /** The start of what the booking ran into: the week, the month, the meeting. */
  windowStart: string;
}

/** Input bounds — generous, but a typo cannot lock a mentor out forever. */
export const POLICY_LIMITS = {
  minNoticeMinutes: { min: 0, max: 14 * 24 * 60 },
  bufferMinutes: { min: 0, max: 240 },
  maxPerWeek: { min: 1, max: 50 },
  maxPerMonth: { min: 1, max: 200 },
  defaultSlotMinutes: { min: 15, max: 240 },
} as const;

export function isEmptyPolicy(p: BookingPolicy | null | undefined): boolean {
  return !p || (p.minNoticeMinutes == null && p.bufferMinutes == null && p.maxPerWeek == null && p.maxPerMonth == null && p.defaultSlotMinutes == null);
}

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** [start, end) of the week (Monday-based) or month that `instant` falls in, in `timezone`. */
export function periodBounds(instant: Date, timezone: string | null | undefined, period: 'week' | 'month'): Window {
  const zone = resolveTimeZone(timezone);
  const date = dateInZone(instant, zone);
  let first: string;
  let next: string;
  if (period === 'week') {
    const sinceMonday = (weekdayInZone(instant, zone) + 6) % 7;
    first = addDays(date, -sinceMonday);
    next = addDays(first, 7);
  } else {
    first = `${date.slice(0, 7)}-01`;
    const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
    next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  }
  return { start: parseWallClockInZone(`${first}T00:00`, zone)!, end: parseWallClockInZone(`${next}T00:00`, zone)! };
}

export interface PolicyCheckInput {
  start: Date;
  end: Date;
  now: Date;
  timezone: string | null | undefined;
  /** The mentor's meetings already in the candidate's week / month. */
  weekCount: number;
  monthCount: number;
  /** The mentor's busy windows around the candidate (other meetings). */
  busy: Window[];
}

/** The first rule this booking breaks, or null. Order: notice, buffer, week, month. */
export function checkPolicy(policy: BookingPolicy | null | undefined, input: PolicyCheckInput): PolicyViolation | null {
  if (!policy) return null;
  if (policy.minNoticeMinutes && input.start.getTime() - input.now.getTime() < policy.minNoticeMinutes * 60_000) {
    return { rule: 'min_notice', limit: policy.minNoticeMinutes, windowStart: input.now.toISOString() };
  }
  if (policy.bufferMinutes) {
    const b = policy.bufferMinutes * 60_000;
    const widened = { start: new Date(input.start.getTime() - b), end: new Date(input.end.getTime() + b) };
    const hit = input.busy.filter((w) => overlaps(widened, w)).sort((x, y) => x.start.getTime() - y.start.getTime())[0];
    if (hit) return { rule: 'buffer', limit: policy.bufferMinutes, windowStart: hit.start.toISOString() };
  }
  if (policy.maxPerWeek && input.weekCount >= policy.maxPerWeek) {
    return { rule: 'weekly_cap', limit: policy.maxPerWeek, windowStart: periodBounds(input.start, input.timezone, 'week').start.toISOString() };
  }
  if (policy.maxPerMonth && input.monthCount >= policy.maxPerMonth) {
    return { rule: 'monthly_cap', limit: policy.maxPerMonth, windowStart: periodBounds(input.start, input.timezone, 'month').start.toISOString() };
  }
  return null;
}

/** Busy windows widened by the buffer, for the offer side: a block touching one is not offered. */
export function widenForBuffer(busy: Window[], bufferMinutes: number | null | undefined): Window[] {
  if (!bufferMinutes) return busy;
  const b = bufferMinutes * 60_000;
  return busy.map((w) => ({ start: new Date(w.start.getTime() - b), end: new Date(w.end.getTime() + b) }));
}
