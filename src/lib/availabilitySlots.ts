import { parseWallClockInZone, resolveTimeZone } from './timezone';

// Turning a mentor's recurring weekly availability into concrete date-times a
// mentee can actually pick (#1361).
//
// A slot is "weekday 1, 09:00–10:00" with no date and no zone of its own; it is
// read in the mentor's `User.timezone` (#1363). Expanding it means walking
// forward from a starting instant and, for each matching weekday, resolving the
// wall clock IN THAT ZONE — not in the viewer's, and not by adding a fixed
// offset. `parseWallClockInZone` does the DST-correct resolution, so a slot that
// straddles a transition keeps its wall-clock time rather than sliding an hour.
//
// Pure and DB-free on purpose: this is the part worth testing exhaustively, and
// it needs neither Prisma nor a browser to do it.

export interface WeeklySlot {
  id: string;
  weekday: number; // 0 = Sunday .. 6 = Saturday
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  /**
   * Set → a ONE-OFF on that calendar date (#2001), offered once and never
   * repeated; `weekday` is then derived from it and ignored here. Accepts what
   * the API serialises (an ISO string at UTC midnight) as well as a bare
   * "YYYY-MM-DD" or a Date, since a `@db.Date` column round-trips as any of them.
   */
  date?: string | Date | null;
}

/**
 * A stretch of days the mentor is away (#2001): every occurrence whose date —
 * in the MENTOR's zone — falls in [startDate, endDate] is suppressed. Both
 * ends inclusive, both calendar dates in the same loose shapes as `date` above.
 */
export interface AvailabilityExceptionRange {
  startDate: string | Date;
  endDate: string | Date;
}

/** "YYYY-MM-DD" from a calendar-date value (a `@db.Date` is UTC midnight). */
export function calendarDate(v: string | Date): string {
  return (typeof v === 'string' ? v : v.toISOString()).slice(0, 10);
}

/** Whether `date` ("YYYY-MM-DD") falls inside any away window. */
export function isAway(date: string, exceptions: AvailabilityExceptionRange[] | undefined): boolean {
  return (exceptions ?? []).some((e) => calendarDate(e.startDate) <= date && date <= calendarDate(e.endDate));
}

/** Sunday-based weekday of a calendar date — no zone involved, a date is a date. */
export function weekdayOfDate(date: string): number {
  return new Date(`${calendarDate(date)}T00:00:00Z`).getUTCDay();
}

export interface SlotOccurrence {
  slotId: string;
  /** The exact instant the slot starts, as an ISO string. */
  startISO: string;
  /** The date the occurrence falls on, in the mentor's zone ("YYYY-MM-DD"). */
  date: string;
  weekday: number;
  startTime: string;
  endTime: string;
}

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" for an instant, read in `timeZone`. */
export function dateInZone(at: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which is the one locale that gives the ISO
  // date shape directly rather than needing the parts reassembled.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** 0..6 (Sunday-based) for an instant, read in `timeZone`. */
function weekdayInZone(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/**
 * Expand weekly slots into the concrete occurrences falling in the next
 * `weeks` weeks, soonest first.
 *
 * Occurrences already in the past are dropped — "this Monday 09:00" is not on
 * offer at Monday 14:00. `from` is a parameter rather than `Date.now()` so the
 * caller decides the clock and a test can pin it.
 */
export function expandSlots(
  slots: WeeklySlot[],
  timezone: string | null | undefined,
  {
    from,
    weeks = 3,
    limit = 30,
    exceptions,
  }: { from: Date; weeks?: number; limit?: number; exceptions?: AvailabilityExceptionRange[] }
): SlotOccurrence[] {
  if (slots.length === 0) return [];
  const zone = resolveTimeZone(timezone);
  const out: SlotOccurrence[] = [];

  // Walk day by day in the mentor's zone. Stepping by 24h from an instant can
  // land on the same calendar date twice across a DST transition, so dedupe on
  // the date string rather than trusting the arithmetic.
  const seen = new Set<string>();
  for (let step = 0; step <= weeks * 7 + 1; step++) {
    const cursor = new Date(from.getTime() + step * DAY_MS);
    const date = dateInZone(cursor, zone);
    if (seen.has(date)) continue;
    seen.add(date);
    // Away that day: nothing on it is offered, weekly or one-off (#2001).
    if (isAway(date, exceptions)) continue;
    const weekday = weekdayInZone(cursor, zone);

    for (const slot of slots) {
      // A one-off lives on its date alone; a weekly slot on its weekday.
      if (slot.date ? calendarDate(slot.date) !== date : slot.weekday !== weekday) continue;
      const start = parseWallClockInZone(`${date}T${slot.startTime}`, zone);
      if (!start || start.getTime() <= from.getTime()) continue;
      out.push({
        slotId: slot.id,
        startISO: start.toISOString(),
        date,
        weekday,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
    }
  }

  return out.sort((a, b) => a.startISO.localeCompare(b.startISO)).slice(0, limit);
}

/**
 * Does `instant` fall on one of these weekly slots, read in `timezone`?
 *
 * Used on the mentor's side to mark a request that landed on their own posted
 * hours. Deliberately derived rather than stored: MeetingRequest keeps only the
 * instant, and a slot the mentor has since deleted should stop being claimed as
 * theirs.
 */
export function matchesSlot(
  instant: Date,
  slots: WeeklySlot[],
  timezone: string | null | undefined
): WeeklySlot | null {
  const zone = resolveTimeZone(timezone);
  const weekday = weekdayInZone(instant, zone);
  const date = dateInZone(instant, zone);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
  return (
    slots.find(
      (s) => (s.date ? calendarDate(s.date) === date : s.weekday === weekday) && time >= s.startTime && time < s.endTime
    ) ?? null
  );
}
