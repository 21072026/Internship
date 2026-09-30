// A MeetingSeries as ONE recurring calendar event (#2654): the RRULE, pure and
// dependency-free so `node --test --experimental-strip-types` loads it directly
// (scripts/test/series-rrule.test.mjs).
//
// The rule's weekdays are the series' own (0 = Sunday … 6 = Saturday, the
// JavaScript convention MeetingSeries.daysOfWeek stores), read on the series'
// own clock. An RRULE's BYDAY is interpreted in the event's `start.timeZone`,
// which the push sets to that same zone, so "Mondays 09:00 Europe/Berlin" stays
// Mondays at 09:00 on both sides of a DST change. That is why the event carries
// a zone and never just a UTC instant.

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/** Normalised 0–6 weekdays, deduplicated and sorted; anything else is dropped. */
export function weekdays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  // Number(null) is 0 (a Sunday nobody chose), so only numbers and numeric
  // strings are read at all.
  const days = (raw as unknown[])
    .map((v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * `RRULE:FREQ=WEEKLY;BYDAY=MO,TH` for the series' weekdays, or null for a rule
 * with none (a malformed row pushes nothing rather than an event that recurs
 * every week on no day, which Google rejects).
 */
export function weeklyRrule(daysOfWeek: unknown): string | null {
  const days = weekdays(daysOfWeek);
  if (days.length === 0) return null;
  return `RRULE:FREQ=WEEKLY;BYDAY=${days.map((d) => BYDAY[d]).join(',')}`;
}
