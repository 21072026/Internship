// Shared shape of the holiday-calendar routes (#1638). Client-safe (zod only).
import { z } from 'zod';

export const MAX_CALENDARS_PER_ORG = 20;
export const MAX_HOLIDAYS_PER_CALENDAR = 400;

export const calendarBody = z.object({
  name: z.string().trim().min(1).max(120),
  text: z.string().max(40_000),
});

export function serializeCalendar(c: { id: string; name: string; holidays: { date: Date; label: string }[] }) {
  return {
    id: c.id,
    name: c.name,
    holidays: c.holidays.map((h) => ({ date: h.date.toISOString().slice(0, 10), label: h.label })),
  };
}
