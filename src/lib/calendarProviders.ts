import { prisma } from '@/lib/prisma';
import { isGoogleCalendarConfigured, isGoogleCalendarEnabled } from '@/lib/googleCalendar';

// The calendar provider registry (#1993).
//
// SERVER ONLY: entries read `process.env` and query Prisma. The card is driven
// entirely by what `GET /api/integrations/calendar/status` returns, so nothing
// in the browser has to know a provider exists — that is the whole point of the
// shape. Adding Microsoft 365/Outlook (#1991) is one more entry in the array
// below; neither the status route nor `ConnectedCalendarsCard` changes.
//
// An ARRAY, not a map keyed by id, because the order the rows appear in is a
// product decision and a map's key order is not one.
//
// Two states the UI must never collapse into one:
//   configured — the OPERATOR has credentials for this provider on this
//                deployment. Without them the connect route can only bounce
//                back with `unavailable`, so the card says so instead of
//                offering a button that cannot work.
//   connected  — THIS PERSON has granted consent and there is a row for them.

export type CalendarProviderId = 'google';

/** What a provider hands back about one person's connection. Never a token. */
export interface CalendarConnectionSummary {
  accountEmail: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
}

export interface CalendarProvider {
  id: CalendarProviderId;
  /** Brand name. Deliberately not translated — "Google Calendar" is a name. */
  label: string;
  /** Operator credentials present on this deployment. */
  isConfigured(): boolean;
  /** Configured AND switched on: credentials can sit in the env long before the
   *  operator wants meetings flowing into real calendars. */
  isEnabled(): boolean;
  /** Starts consent. Also the reconnect target — re-running consent is exactly
   *  what repairs a revoked token. */
  connectPath: string;
  /** DELETE here to revoke at the provider and forget the tokens. */
  disconnectPath: string;
  /**
   * This user's own connection, or null. The `select` is an explicit allowlist:
   * a token column can only reach a caller by being named here, so the safe
   * thing is the default rather than something a later edit has to remember to
   * strip off again.
   */
  readConnection(userId: string): Promise<CalendarConnectionSummary | null>;
}

export const CALENDAR_PROVIDERS: readonly CalendarProvider[] = [
  {
    id: 'google',
    label: 'Google Calendar',
    isConfigured: isGoogleCalendarConfigured,
    isEnabled: isGoogleCalendarEnabled,
    connectPath: '/api/integrations/google/connect',
    disconnectPath: '/api/integrations/google/connection',
    async readConnection(userId) {
      const conn = await prisma.googleCalendarConnection.findUnique({
        where: { userId },
        select: { googleEmail: true, lastSyncAt: true, lastError: true },
      });
      if (!conn) return null;
      return { accountEmail: conn.googleEmail, lastSyncAt: conn.lastSyncAt, lastError: conn.lastError };
    },
  },
];
