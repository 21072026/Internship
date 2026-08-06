import { parseWallClockInZone } from '@/lib/timezone';

// Expanding a recurring meeting rule into the occurrences that fall inside a
// window (#1110).
//
// A `MeetingSeries` stores a weekday set plus a wall-clock "HH:mm" on a named
// zone. Nothing is materialised per occurrence any more, so every surface that
// needs to know when the weekly call is — the calendar, the dashboard banner,
// the reminder cron — expands the rule through here. One implementation means
// the calendar can never disagree with the reminder about what time it is.
//
// The zone matters: `timeOfDay` used to be anchored to UTC, so a rule the UI
// displayed as "09:00" was mailed to an Istanbul mentee as "12:00 (GMT+3)".
// Rules written before #1110 have no zone and fall back to the deployment
// default — which is the clock the UI was showing them on all along.

/** Hard ceiling on how far a single expansion may run, so a bad window can't spin. */
const MAX_WINDOW_DAYS = 400;

const pad = (n: number) => String(n).padStart(2, '0');

/** Normalise the stored JSON weekday array into 0–6 integers. */
export function parseDaysOfWeek(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const days = (raw as unknown[])
    .map(Number)
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Every occurrence of the rule with `from <= occurrence <= to`, ascending.
 * Returns an empty list for a malformed rule or an inverted window.
 */
export function seriesOccurrences(
  daysOfWeek: unknown,
  timeOfDay: string,
  from: Date,
  to: Date,
  timeZone?: string | null
): Date[] {
  const days = parseDaysOfWeek(daysOfWeek);
  if (days.length === 0 || to < from) return [];
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(timeOfDay))) return [];

  const allowed = new Set(days);
  const out: Date[] = [];
  // The cursor counts *calendar dates*, not instants: a date's weekday is the
  // same in every zone, and each date is turned into an instant below. Padding
  // by a day on each side covers zones up to ±14h from UTC.
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  const lastDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  lastDay.setUTCDate(lastDay.getUTCDate() + 1);

  for (let i = 0; i <= MAX_WINDOW_DAYS + 2 && cursor <= lastDay; i++) {
    if (allowed.has(cursor.getUTCDay())) {
      const wall = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}T${timeOfDay}`;
      const when = parseWallClockInZone(wall, timeZone);
      if (when && when >= from && when <= to) out.push(when);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

/** The first occurrence at or after `from`, within `days` days. Null when the rule is idle. */
export function nextOccurrence(
  daysOfWeek: unknown,
  timeOfDay: string,
  timeZone?: string | null,
  from: Date = new Date(),
  days = 14
): Date | null {
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  return seriesOccurrences(daysOfWeek, timeOfDay, from, to, timeZone)[0] ?? null;
}
