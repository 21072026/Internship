/** What a calendar push needs of a meeting (#709, #1984). */
export interface PushableMeeting {
  id: string;
  title: string;
  scheduledAt: Date | null;
  timeZone: string | null;
  meetLink: string | null;
  // The stored length (#1984); null reads as the one default.
  durationMinutes: number | null;
}

/**
 * The fields a push needs, as one Prisma `select` (#1986). Every push site
 * spreads this into its query, so a field added to the calendar event here
 * cannot be forgotten at one of them.
 */
export const pushableSelect = {
  id: true,
  title: true,
  scheduledAt: true,
  timeZone: true,
  meetLink: true,
  durationMinutes: true,
} as const satisfies Record<keyof PushableMeeting, true>;
