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
function dateInZone(at: Date, timeZone: string): string {
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
  { from, weeks = 3, limit = 30 }: { from: Date; weeks?: number; limit?: number }
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
    const weekday = weekdayInZone(cursor, zone);

    for (const slot of slots) {
      if (slot.weekday !== weekday) continue;
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
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
  return (
    slots.find((s) => s.weekday === weekday && time >= s.startTime && time < s.endTime) ?? null
  );
}
