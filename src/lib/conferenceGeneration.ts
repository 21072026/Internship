// A real Google Meet or Microsoft Teams room for a scheduled meeting (#2009),
// created on the organiser's OWN connected calendar through the provider
// interface (src/lib/calendar/provider.ts, `createConference`). The scopes we
// already hold — Google `calendar.events`, Graph `Calendars.ReadWrite` — are
// exactly the ones room creation needs, so nobody is asked to consent again.
//
// THE ORDERING PROBLEM, AND THE CHOICE MADE
//   The calendar mirror is fire-and-forget by design (pushMeetingInBackground):
//   a third party's API may never make scheduling fail or hang. But a provider
//   room only exists once the provider has created the event, and the invite
//   mail goes out in the same request. Two honest answers were on the table:
//     (a) hold the invite for a short, BOUNDED window while the event is
//         created, and use whatever came back — the provider's room, or
//         another one if the provider was slow or said no;
//     (b) put no raw URL in the invite, only a link to the app's meeting page.
//   We take (a). Every existing surface — the invite mail, the .ics, the
//   reminder, the dashboard banner, the subscription feed — already reads ONE
//   `Meeting.meetLink`, so (a) changes nothing downstream, and (b) would have
//   meant rewriting all of them. The bound is GENERATE_TIMEOUT_MS: past it the
//   request continues with the next room and the late event is deleted, never
//   adopted, so participants only ever see the one link they were sent. The
//   worst case is a few seconds on a scheduling request whose tenant asked for it.
//
// WHAT IT NEVER DOES
//   - Fail a meeting: no connection, a refused token, an error or a timeout all
//     return null and the caller falls back (resolveMeetingLink). The reason is
//     recorded on the connection (CONFERENCE_NOTE_PREFIX), where /account shows it.
//   - Send two links: a timed-out create is abandoned, never written back.
//
// Zoom is deferred by decision — docs/conferencing.md.

import { prisma } from '@/lib/prisma';
import { enabledSyncProviders, type CalendarAuth, type CalendarSyncProvider, type ConferenceSlot } from '@/lib/calendar/provider';
import { CONFERENCE_NOTE_PREFIX } from '@/lib/calendar/conferenceNote';
import type { CalendarProviderKind } from '@prisma/client';

export type { ConferenceSlot } from '@/lib/calendar/provider';

/** The longest a scheduling request waits for the provider before using another room. */
export const GENERATE_TIMEOUT_MS = 4_000;

export interface GeneratedConference {
  provider: CalendarProviderKind;
  link: string;
  /** The event on the organiser's calendar that carries the room — adopted as the mirror. */
  connectionId: string;
  eventId: string;
}

/**
 * The organiser's first connected provider that can make a room, with a usable
 * token. Google before Microsoft, the registry's order, when both are connected.
 */
async function connectedProvider(organizerId: string): Promise<{ provider: CalendarSyncProvider; auth: CalendarAuth } | null> {
  for (const provider of enabledSyncProviders()) {
    const auth = await provider.accessTokenFor(organizerId).catch(() => null);
    if (auth) return { provider, auth };
  }
  return null;
}

/** Can this organiser get a generated room at all? Cheap: no call to a provider. */
export async function providerAvailableFor(organizerId: string | null | undefined): Promise<boolean> {
  const kinds = enabledSyncProviders().map((p) => p.kind);
  if (!organizerId || kinds.length === 0) return false;
  const conn = await prisma.calendarConnection
    .findFirst({ where: { userId: organizerId, provider: { in: kinds } }, select: { id: true } })
    .catch(() => null);
  return Boolean(conn);
}

const note = (provider: CalendarSyncProvider, connectionId: string, what: string) =>
  provider.noteError(connectionId, `${CONFERENCE_NOTE_PREFIX} ${what} — the meeting used another room.`);

/**
 * Create the organiser's calendar event with a provider room, bounded by
 * `timeoutMs`. Null on any failure — the caller falls back to another room.
 */
export async function generateProviderConference(
  organizerId: string,
  slot: ConferenceSlot,
  timeoutMs = GENERATE_TIMEOUT_MS,
): Promise<GeneratedConference | null> {
  const found = await connectedProvider(organizerId);
  if (!found) return null;
  const { provider, auth } = found;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const call = provider.createConference(auth, slot).catch(() => null);
  const res = await Promise.race([call, timeout]);
  if (timer) clearTimeout(timer);

  if (res === 'timeout') {
    await note(provider, auth.connectionId, 'timed out');
    // The event may still land late; it carries a room nobody was sent, so remove it.
    void call.then((late) => {
      if (late?.ok && late.eventId) void provider.deleteEvent(auth, auth.calendarId, late.eventId).catch(() => {});
    });
    return null;
  }
  if (!res || !res.ok) {
    await note(provider, auth.connectionId, res?.status ? `failed (${res.status})` : 'failed');
    return null;
  }
  if (!res.joinUrl || !res.eventId) {
    await note(provider, auth.connectionId, 'returned no room');
    if (res.eventId) void provider.deleteEvent(auth, auth.calendarId, res.eventId).catch(() => {});
    return null;
  }
  // A working generation retires an earlier failure note.
  await prisma.calendarConnection
    .updateMany({ where: { id: auth.connectionId, lastError: { startsWith: CONFERENCE_NOTE_PREFIX } }, data: { lastError: null } })
    .catch(() => {});
  return { provider: provider.kind, link: res.joinUrl, connectionId: auth.connectionId, eventId: res.eventId };
}

/**
 * Make the generated event THE mirror of these meeting rows on the organiser's
 * calendar, so the background push PATCHes it instead of creating a second
 * event. Call it before pushMeetingInBackground for the same row.
 */
export async function adoptProviderEvent(meetingIds: string[], conference: GeneratedConference | undefined): Promise<void> {
  if (!conference) return;
  for (const meetingId of meetingIds) {
    await prisma.calendarEventLink
      .upsert({
        where: { meetingId_connectionId: { meetingId, connectionId: conference.connectionId } },
        update: { externalEventId: conference.eventId, pushedAt: new Date() },
        create: { meetingId, connectionId: conference.connectionId, externalEventId: conference.eventId },
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
  const provider = enabledSyncProviders().find((p) => p.kind === conference.provider);
  if (!provider) return;
  const auth = await provider.accessTokenFor(organizerId).catch(() => null);
  if (auth) await provider.deleteEvent(auth, auth.calendarId, conference.eventId).catch(() => {});
}
