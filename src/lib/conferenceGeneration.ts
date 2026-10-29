// A real Google Meet room for a scheduled meeting (#2009), created on the
// organiser's OWN connected calendar — the `calendar.events` scope we already
// hold (src/lib/googleCalendar.ts) is exactly the one Meet creation needs, so
// nobody is asked to consent again.
//
// THE ORDERING PROBLEM, AND THE CHOICE MADE
//   The calendar mirror is fire-and-forget by design (pushMeetingInBackground):
//   a third party's API may never make scheduling fail or hang. But a Meet
//   link only exists once Google has created the event, and the invite mail
//   goes out in the same request. Two honest answers were on the table:
//     (a) hold the invite for a short, BOUNDED window while the event is
//         created, and use whatever came back — the Meet link, or our own
//         room if Google was slow or said no;
//     (b) put no raw URL in the invite, only a link to the app's meeting page.
//   We take (a). Every existing surface — the invite mail, the .ics, the
//   reminder, the dashboard banner, the subscription feed — already reads ONE
//   `Meeting.meetLink`, so (a) changes nothing downstream, and (b) would have
//   meant rewriting all of them. The bound is GENERATE_TIMEOUT_MS: past it the
//   request continues with our room and the late Meet event is never adopted,
//   so participants only ever see the one link they were sent. The worst case
//   is a few seconds on a scheduling request whose tenant asked for this.
//
// WHAT IT NEVER DOES
//   - Fail a meeting: no connection, a refused token, an error or a timeout all
//     return null, and the caller falls back (resolveMeetingLink). The reason
//     is recorded on the connection (noteError), where /account shows it.
//   - Send two links: a timed-out create is abandoned, never written back.
//
// Microsoft Teams (isOnlineMeeting + teamsForBusiness) follows when the Graph
// connection (#1991) exists; Zoom is deferred by decision — docs/conferencing.md.

import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { accessTokenFor, calendarFetch, noteError } from '@/lib/googleCalendarClient';

/** Every note this module leaves on the connection starts with it (the mirror push leaves those alone). */
export const MEET_NOTE_PREFIX = 'Meet link generation';

/** The longest a scheduling request waits for Google before using our room. */
export const GENERATE_TIMEOUT_MS = 4_000;

export interface ConferenceContext {
  title: string;
  start: Date;
  end: Date;
  timeZone: string | null;
}

export interface GeneratedConference {
  provider: 'google_meet';
  link: string;
  /** The event on the organiser's calendar that carries the room — adopted as the mirror. */
  connectionId: string;
  eventId: string;
}

/** Can this organiser get a generated room at all? Cheap: no call to Google. */
export async function providerAvailableFor(organizerId: string | null | undefined): Promise<boolean> {
  if (!organizerId || !isGoogleCalendarEnabled()) return false;
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { userId: organizerId }, select: { id: true } }).catch(() => null);
  return Boolean(conn);
}

/** The join URL Google returned: `hangoutLink`, else the video entry point. */
export function meetLinkFromEvent(body: Record<string, unknown>): string | null {
  if (typeof body.hangoutLink === 'string' && body.hangoutLink.startsWith('https://')) return body.hangoutLink;
  const data = body.conferenceData as { entryPoints?: { entryPointType?: string; uri?: string }[] } | undefined;
  const video = data?.entryPoints?.find((e) => e.entryPointType === 'video' && typeof e.uri === 'string' && e.uri.startsWith('https://'));
  return video?.uri ?? null;
}

/**
 * Create the organiser's calendar event with a Meet room, bounded by
 * `timeoutMs`. Null on any failure — the caller falls back to another room.
 */
export async function generateProviderConference(
  organizerId: string,
  ctx: ConferenceContext,
  timeoutMs = GENERATE_TIMEOUT_MS,
): Promise<GeneratedConference | null> {
  if (!isGoogleCalendarEnabled()) return null;
  const auth = await accessTokenFor(organizerId).catch(() => null);
  if (!auth) return null;

  const body = {
    summary: ctx.title,
    start: { dateTime: ctx.start.toISOString(), ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}) },
    end: { dateTime: ctx.end.toISOString(), ...(ctx.timeZone ? { timeZone: ctx.timeZone } : {}) },
    conferenceData: { createRequest: { requestId: randomBytes(12).toString('hex'), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
  };
  const path = `/calendars/${encodeURIComponent(auth.calendarId)}/events?conferenceDataVersion=1`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const call = calendarFetch(auth.token, path, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
  const res = await Promise.race([call, timeout]);
  if (timer) clearTimeout(timer);

  if (res === 'timeout') {
    await noteError(auth.connectionId, 'Meet link generation timed out — the meeting used the built-in room.');
    // The event may still land late; it carries a room nobody was sent, so remove it.
    void call.then((late) => {
      const id = late?.ok && typeof late.body.id === 'string' ? late.body.id : null;
      if (id) void calendarFetch(auth.token, `/calendars/${encodeURIComponent(auth.calendarId)}/events/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    });
    return null;
  }
  if (!res || !res.ok) {
    await noteError(auth.connectionId, res ? `Meet link generation failed (${res.status}) — the meeting used the built-in room.` : 'Meet link generation failed — the meeting used the built-in room.');
    return null;
  }
  const link = meetLinkFromEvent(res.body);
  const eventId = typeof res.body.id === 'string' ? res.body.id : null;
  if (!link || !eventId) {
    await noteError(auth.connectionId, 'Meet link generation returned no room — the meeting used the built-in room.');
    if (eventId) void calendarFetch(auth.token, `/calendars/${encodeURIComponent(auth.calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' }).catch(() => null);
    return null;
  }
  // A working generation retires an earlier failure note.
  await prisma.googleCalendarConnection
    .updateMany({ where: { id: auth.connectionId, lastError: { startsWith: MEET_NOTE_PREFIX } }, data: { lastError: null } })
    .catch(() => {});
  return { provider: 'google_meet', link, connectionId: auth.connectionId, eventId };
}

/**
 * Make the generated event THE mirror of these meeting rows on the organiser's
 * calendar, so the background push PATCHes it instead of creating a second
 * event. Call it before pushMeetingInBackground for the same row.
 */
export async function adoptProviderEvent(meetingIds: string[], conference: GeneratedConference | undefined): Promise<void> {
  if (!conference) return;
  for (const meetingId of meetingIds) {
    await prisma.googleCalendarEventLink
      .upsert({
        where: { meetingId_connectionId: { meetingId, connectionId: conference.connectionId } },
        update: { googleEventId: conference.eventId, pushedAt: new Date() },
        create: { meetingId, connectionId: conference.connectionId, googleEventId: conference.eventId },
      })
      .catch(() => {});
  }
}

/**
 * Remove a generated event that no meeting row came of (the caller lost a race
 * after the room was made): it carries a room nobody was sent. Never throws.
 */
export async function discardProviderEvent(organizerId: string, conference: GeneratedConference | undefined): Promise<void> {
  if (!conference) return;
  const auth = await accessTokenFor(organizerId).catch(() => null);
  if (!auth) return;
  await calendarFetch(auth.token, `/calendars/${encodeURIComponent(auth.calendarId)}/events/${encodeURIComponent(conference.eventId)}`, { method: 'DELETE' }).catch(() => null);
}
