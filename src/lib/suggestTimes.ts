// The scheduling assistant (#1999) — pure and client-safe. `AttendeeTimes`
// explains a time after somebody picked it; this proposes the times worth
// picking: the mentor's posted hours, minus every attendee's busy windows,
// inside working hours on EVERY attendee's own clock, soonest first.
//
// "Free for everyone" is not an intersection of published availability —
// mentees publish none (AvailabilitySlot is mentor-only). It is the mentor's
// hours minus what anybody is already doing. The busy windows come in as an
// argument (the route reads them, src/lib/busyWindows.ts, with the mentor's
// buffer already applied), so this file is unit-tested without a database:
// scripts/test/suggest-times.test.mjs.

import { expandSlots, type AvailabilityExceptionRange, type WeeklySlot } from '@/lib/availabilitySlots';
import { overlaps, type Window } from '@/lib/busyWindowsRule';
import { resolveTimeZone } from '@/lib/timezone';

/** 08:00–20:00: a slot at 03:00 for the mentee is not a suggestion, it is an insult. */
export const WORKDAY = { startMinute: 8 * 60, endMinute: 20 * 60 } as const;

/** Why there is nothing to suggest — the binding constraint, named. */
export type SuggestEmptyReason = 'no_hours' | 'all_taken' | 'outside_hours';

export interface Suggestion {
  startISO: string;
  endISO: string;
}

export interface SuggestInput {
  slots: WeeklySlot[];
  mentorZone: string | null | undefined;
  exceptions?: AvailabilityExceptionRange[];
  /** Everyone who would attend, mentor included — each one's zone bounds the day. */
  attendeeZones: (string | null | undefined)[];
  busy: Window[];
  from: Date;
  weeks?: number;
  durationMinutes: number;
  minNoticeMinutes?: number | null;
}

/** Minutes since local midnight of `at` in `zone`. */
function localMinute(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return n('hour') * 60 + n('minute');
}

/** Whether [start, end) sits inside 08:00–20:00 on this clock — on one calendar day. */
export function insideWorkday(start: Date, end: Date, timezone: string | null | undefined): boolean {
  const zone = resolveTimeZone(timezone);
  const s = localMinute(start, zone);
  // The end instant is exclusive: a meeting ending 20:00 sharp ends inside the day.
  const e = localMinute(new Date(end.getTime() - 60_000), zone) + 1;
  return s >= WORKDAY.startMinute && e <= WORKDAY.endMinute && e > s;
}

/** Ranking key: soonest first, but an on-the-hour start beats a :30 one up to 45 minutes later. */
function rankKey(start: Date, zone: string): number {
  const onTheHour = localMinute(start, zone) % 60 === 0;
  return start.getTime() + (onTheHour ? 0 : 45 * 60_000);
}

/**
 * Every free candidate, best first (callers take as many as they show), or
 * the binding constraint when there is none.
 */
export function suggestTimes(input: SuggestInput): { suggestions: Suggestion[]; reason: SuggestEmptyReason | null } {
  const duration = input.durationMinutes;
  // The window's own `slotMinutes` describes the mentor's offer, not this
  // meeting: a suggestion is sliced to the length being booked.
  const slots = input.slots.map((s) => ({ ...s, slotMinutes: null }));
  const candidates = expandSlots(slots, input.mentorZone, {
    from: input.from,
    weeks: input.weeks ?? 3,
    limit: 2000,
    exceptions: input.exceptions,
    slotMinutes: duration,
    minNoticeMinutes: input.minNoticeMinutes,
  }).map((o) => {
    const start = new Date(o.startISO);
    return { start, end: new Date(start.getTime() + duration * 60_000) };
  });
  if (candidates.length === 0) return { suggestions: [], reason: 'no_hours' };

  const free = candidates.filter((c) => !input.busy.some((b) => overlaps(c, b)));
  if (free.length === 0) return { suggestions: [], reason: 'all_taken' };

  const zones = input.attendeeZones.length ? input.attendeeZones : [input.mentorZone];
  const humane = free.filter((c) => zones.every((z) => insideWorkday(c.start, c.end, z)));
  if (humane.length === 0) return { suggestions: [], reason: 'outside_hours' };

  const mentorZone = resolveTimeZone(input.mentorZone);
  const ranked = humane.sort((a, b) => rankKey(a.start, mentorZone) - rankKey(b.start, mentorZone));
  return { suggestions: ranked.map((c) => ({ startISO: c.start.toISOString(), endISO: c.end.toISOString() })), reason: null };
}
