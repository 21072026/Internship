import { isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { accessTokenFor, calendarFetch, noteError } from '@/lib/googleCalendarClient';
import { meetingEnd } from '@/lib/meetingDuration';
import type { CalendarSyncProvider } from '@/lib/calendar/provider';
import type { PushableMeeting } from '@/lib/calendar/pushable';

// Google's half of the meeting sync (#709, behind the interface since #1989).
// The only Google-shaped part of a push is the event body below; the loop that
// decides create-vs-patch and cleans up dead pointers lives in the sync module.

function eventBody(meeting: PushableMeeting, product: string) {
  const start = meeting.scheduledAt!;
  const end = meetingEnd(start, meeting);
  return {
    summary: meeting.title,
    description: meeting.meetLink ? `Join: ${meeting.meetLink}` : undefined,
    location: meeting.meetLink ?? undefined,
    start: { dateTime: start.toISOString(), ...(meeting.timeZone ? { timeZone: meeting.timeZone } : {}) },
    end: { dateTime: end.toISOString(), ...(meeting.timeZone ? { timeZone: meeting.timeZone } : {}) },
    source: { title: product, url: meeting.meetLink ?? undefined },
  };
}

const eventPath = (calendarId: string, eventId?: string | null) =>
  `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;

export const googleSyncProvider: CalendarSyncProvider = {
  kind: 'GOOGLE',
  isEnabled: isGoogleCalendarEnabled,
  accessTokenFor,
  noteError,
  async writeEvent(auth, meeting, product, existingEventId) {
    const res = await calendarFetch(auth.token, eventPath(auth.calendarId, existingEventId), {
      method: existingEventId ? 'PATCH' : 'POST',
      body: JSON.stringify(eventBody(meeting, product)),
    }).catch(() => null);
    if (!res) return { ok: false, status: 0 };
    return { ok: res.ok, status: res.status, eventId: typeof res.body.id === 'string' ? res.body.id : undefined };
  },
  async deleteEvent(auth, calendarId, eventId) {
    await calendarFetch(auth.token, eventPath(calendarId, eventId), { method: 'DELETE' }).catch(() => null);
  },
};
