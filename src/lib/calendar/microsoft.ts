import { isMicrosoftCalendarEnabled } from '@/lib/microsoftCalendar';
import { graphFetch, microsoftAccessTokenFor, noteMicrosoftError } from '@/lib/microsoftCalendarClient';
import { graphEventBody } from '@/lib/calendar/microsoftEvent';
import type { CalendarSyncProvider } from '@/lib/calendar/provider';

// Microsoft Graph's half of the meeting sync (#1991). `calendarId` 'primary' is
// the person's default calendar — Graph's `/me/events` — and anything else is
// a named calendar under `/me/calendars/{id}/events`.

const eventsPath = (calendarId: string) =>
  calendarId === 'primary' ? '/me/events' : `/me/calendars/${encodeURIComponent(calendarId)}/events`;

export const microsoftSyncProvider: CalendarSyncProvider = {
  kind: 'MICROSOFT',
  isEnabled: isMicrosoftCalendarEnabled,
  accessTokenFor: microsoftAccessTokenFor,
  noteError: noteMicrosoftError,
  async writeEvent(auth, meeting, product, existingEventId) {
    const path = existingEventId ? `/me/events/${encodeURIComponent(existingEventId)}` : eventsPath(auth.calendarId);
    const res = await graphFetch(auth.token, path, {
      method: existingEventId ? 'PATCH' : 'POST',
      body: JSON.stringify(graphEventBody({ ...meeting, scheduledAt: meeting.scheduledAt! }, product)),
    }).catch(() => null);
    if (!res) return { ok: false, status: 0 };
    return { ok: res.ok, status: res.status, eventId: typeof res.body.id === 'string' ? res.body.id : undefined };
  },
  async createConference(auth, slot) {
    // A Teams meeting comes with the event on isOnlineMeeting + the provider
    // (#2009); Graph answers with onlineMeeting.joinUrl.
    const body = {
      ...graphEventBody({ title: slot.title, scheduledAt: slot.start, timeZone: slot.timeZone, meetLink: null, durationMinutes: Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000) }, ''),
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
    };
    const res = await graphFetch(auth.token, eventsPath(auth.calendarId), { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
    if (!res) return { ok: false, status: 0 };
    const online = res.body.onlineMeeting as { joinUrl?: unknown } | undefined;
    const joinUrl = typeof online?.joinUrl === 'string' && online.joinUrl.startsWith('https://') ? online.joinUrl : undefined;
    return { ok: res.ok, status: res.status, eventId: typeof res.body.id === 'string' ? res.body.id : undefined, joinUrl };
  },
  async deleteEvent(auth, _calendarId, eventId) {
    await graphFetch(auth.token, `/me/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }).catch(() => null);
  },
};
