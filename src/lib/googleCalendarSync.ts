import { prisma } from '@/lib/prisma';
import { isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { accessTokenFor, calendarFetch, noteError } from '@/lib/googleCalendarClient';

/**
 * Pushing meetings into connected users' own Google Calendars (#709).
 *
 * Every entry point here is a no-op unless the operator has switched the
 * integration on AND the person has connected their own account. Unconnected
 * users keep exactly the behaviour they had: in-app meeting, invite e-mail,
 * `.ics` attachment, reminders. That is the promise the flag exists to keep,
 * so it is checked once at the top of each function rather than trusted to
 * callers.
 *
 * Failures are swallowed and recorded on the connection, never surfaced to the
 * organiser: a calendar that would not accept the event must not make
 * scheduling a meeting fail. The meeting is the product; the mirror is a
 * convenience.
 */

/** An hour, the same assumption the dashboard's "meeting is on" banner makes. */
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

export interface PushableMeeting {
  id: string;
  title: string;
  scheduledAt: Date | null;
  timeZone: string | null;
  meetLink: string | null;
}

function eventBody(meeting: PushableMeeting) {
  // A meeting with no time is a shared link, not a calendar entry — there is
  // nothing to put in a slot. Those are skipped by the caller.
  const start = meeting.scheduledAt!;
  const end = new Date(start.getTime() + DEFAULT_DURATION_MS);
  return {
    summary: meeting.title,
    description: meeting.meetLink ? `Join: ${meeting.meetLink}` : undefined,
    location: meeting.meetLink ?? undefined,
    start: { dateTime: start.toISOString(), ...(meeting.timeZone ? { timeZone: meeting.timeZone } : {}) },
    end: { dateTime: end.toISOString(), ...(meeting.timeZone ? { timeZone: meeting.timeZone } : {}) },
    source: { title: 'Internship CRM', url: meeting.meetLink ?? undefined },
  };
}

/**
 * Create or update this meeting on each given user's calendar.
 *
 * Per user, not per meeting: everyone connected gets the event on their OWN
 * calendar, which is the only place this app is allowed to write.
 */
export async function pushMeeting(meeting: PushableMeeting, userIds: string[]): Promise<number> {
  if (!isGoogleCalendarEnabled()) return 0;
  if (!meeting.scheduledAt) return 0;

  let pushed = 0;
  for (const userId of [...new Set(userIds)]) {
    const auth = await accessTokenFor(userId);
    if (!auth) continue;

    const link = await prisma.googleCalendarEventLink.findUnique({
      where: { meetingId_connectionId: { meetingId: meeting.id, connectionId: auth.connectionId } },
    });
    const path = `/calendars/${encodeURIComponent(auth.calendarId)}/events${link ? `/${encodeURIComponent(link.googleEventId)}` : ''}`;

    const res = await calendarFetch(auth.token, path, {
      method: link ? 'PATCH' : 'POST',
      body: JSON.stringify(eventBody(meeting)),
    }).catch(() => null);

    if (!res || !res.ok) {
      await noteError(auth.connectionId, res ? `Calendar write failed (${res.status})` : 'Calendar write failed');
      // A remembered event id that Google no longer has is a dead pointer; drop
      // it so the next push creates a fresh event instead of patching a ghost.
      if (res?.status === 404 && link) {
        await prisma.googleCalendarEventLink.delete({ where: { id: link.id } }).catch(() => {});
      }
      continue;
    }

    const eventId = typeof res.body.id === 'string' ? res.body.id : link?.googleEventId;
    if (eventId) {
      await prisma.googleCalendarEventLink.upsert({
        where: { meetingId_connectionId: { meetingId: meeting.id, connectionId: auth.connectionId } },
        update: { googleEventId: eventId, pushedAt: new Date() },
        create: { meetingId: meeting.id, connectionId: auth.connectionId, googleEventId: eventId },
      });
    }
    await prisma.googleCalendarConnection.update({
      where: { id: auth.connectionId },
      data: { lastSyncAt: new Date(), lastError: null },
    }).catch(() => {});
    pushed++;
  }
  return pushed;
}

/** Delete this meeting from every calendar it was mirrored to. */
export async function removeMeeting(meetingId: string): Promise<void> {
  if (!isGoogleCalendarEnabled()) return;
  const links = await prisma.googleCalendarEventLink.findMany({
    where: { meetingId },
    include: { connection: { select: { userId: true, calendarId: true } } },
  });
  for (const link of links) {
    const auth = await accessTokenFor(link.connection.userId);
    if (auth) {
      await calendarFetch(
        auth.token,
        `/calendars/${encodeURIComponent(link.connection.calendarId)}/events/${encodeURIComponent(link.googleEventId)}`,
        { method: 'DELETE' }
      ).catch(() => null);
    }
    // Drop our record either way: the meeting is gone from this app, and a link
    // pointing at an event we can no longer reach is worse than no link.
    await prisma.googleCalendarEventLink.delete({ where: { id: link.id } }).catch(() => {});
  }
}

/**
 * Fire-and-forget wrapper for request handlers.
 *
 * Scheduling a meeting must not wait on — or fail because of — a third party's
 * calendar API.
 */
export function pushMeetingInBackground(meeting: PushableMeeting, userIds: string[]): void {
  if (!isGoogleCalendarEnabled()) return;
  void pushMeeting(meeting, userIds).catch((e) => console.error('Google Calendar push failed:', e));
}
