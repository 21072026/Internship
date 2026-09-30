import { z } from 'zod';

// How long a meeting runs — ONE rule (#1984). Client-safe: no Prisma.
//
// `Meeting` had no duration column, so three places invented one and two of
// them disagreed: the dashboard banner and the mirrored Google event assumed
// 60 minutes, the `.ics` builder 30. Every meeting a participant downloaded or
// subscribed to ended half an hour early in their calendar. Now the length is
// stored (`Meeting.durationMinutes`, `MeetingSeries.durationMinutes`), a row
// written before the column existed reads as the default below, and every
// reader — banner, `.ics`, subscription feed, Google mirror, invite mail — asks
// `meetingDurationMinutes()` instead of carrying its own number.

/** The length a meeting has when nobody said otherwise. */
export const DEFAULT_MEETING_MINUTES = 60;

/** Session-type presets offered on the scheduling forms. */
export const MEETING_DURATION_PRESETS = [15, 30, 45, 60, 90] as const;

/** Bounds the API accepts: five minutes to a working day. */
export const MIN_MEETING_MINUTES = 5;
export const MAX_MEETING_MINUTES = 480;

/** The field every create/update schema spreads — optional, validated the same way everywhere. */
export const durationMinutesField = z.number().int().min(MIN_MEETING_MINUTES).max(MAX_MEETING_MINUTES).optional();

/** The stored length of a meeting (or series), or the default for a row that has none. */
export function meetingDurationMinutes(row: { durationMinutes?: number | null } | null | undefined): number {
  const stored = row?.durationMinutes;
  return typeof stored === 'number' && stored > 0 ? stored : DEFAULT_MEETING_MINUTES;
}

/** When a meeting that starts at `start` ends. */
export function meetingEnd(start: Date, row: { durationMinutes?: number | null } | null | undefined): Date {
  return new Date(start.getTime() + meetingDurationMinutes(row) * 60_000);
}
