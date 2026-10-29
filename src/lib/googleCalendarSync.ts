import { prisma } from '@/lib/prisma';
import { productNameForOrg } from '@/lib/orgBrand';
import { anyCalendarSyncEnabled, enabledSyncProviders, type CalendarSyncProvider } from '@/lib/calendar/provider';
import type { PushableMeeting } from '@/lib/calendar/pushable';

export { pushableSelect, type PushableMeeting } from '@/lib/calendar/pushable';

/**
 * Pushing meetings into connected users' own calendars (#709) — Google, and
 * since #1991 Microsoft 365, through the CalendarSyncProvider interface
 * (src/lib/calendar/provider.ts). The file keeps its historical name because
 * every push site imports it; nothing in here speaks one provider's API.
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

/**
 * Create or update this meeting on each given user's calendar.
 *
 * Per user, not per meeting: everyone connected gets the event on their OWN
 * calendar, which is the only place this app is allowed to write.
 */
export async function pushMeeting(meeting: PushableMeeting, userIds: string[]): Promise<number> {
  if (!meeting.scheduledAt) return 0;
  const providers = enabledSyncProviders();
  if (providers.length === 0) return 0;

  let pushed = 0;
  for (const userId of [...new Set(userIds)]) {
    // Named per RECIPIENT, not per meeting: the event lands in that person's
    // calendar and must name the product their account lives in.
    let product: string | null = null;
    for (const provider of providers) {
      const auth = await provider.accessTokenFor(userId);
      if (!auth) continue;
      if (product === null) {
        const owner = await prisma.user.findUnique({ where: { id: userId }, select: { orgId: true } });
        product = await productNameForOrg(owner?.orgId);
      }
      if (await pushOne(provider, auth, meeting, product)) pushed++;
    }
  }
  return pushed;
}

async function pushOne(
  provider: CalendarSyncProvider,
  auth: { token: string; connectionId: string; calendarId: string },
  meeting: PushableMeeting,
  product: string
): Promise<boolean> {
  const link = await prisma.calendarEventLink.findUnique({
    where: { meetingId_connectionId: { meetingId: meeting.id, connectionId: auth.connectionId } },
  });
  const res = await provider.writeEvent(auth, meeting, product, link?.externalEventId ?? null).catch(() => null);

  if (!res || !res.ok) {
    await provider.noteError(auth.connectionId, res?.status ? `Calendar write failed (${res.status})` : 'Calendar write failed');
    // A remembered event id the provider no longer has is a dead pointer; drop
    // it so the next push creates a fresh event instead of patching a ghost.
    if (res?.status === 404 && link) {
      await prisma.calendarEventLink.delete({ where: { id: link.id } }).catch(() => {});
    }
    return false;
  }

  const eventId = res.eventId ?? link?.externalEventId;
  if (eventId) {
    await prisma.calendarEventLink.upsert({
      where: { meetingId_connectionId: { meetingId: meeting.id, connectionId: auth.connectionId } },
      update: { externalEventId: eventId, pushedAt: new Date() },
      create: { meetingId: meeting.id, connectionId: auth.connectionId, externalEventId: eventId },
    });
  }
  await prisma.calendarConnection.update({
    where: { id: auth.connectionId },
    data: { lastSyncAt: new Date(), lastError: null },
  }).catch(() => {});
  return true;
}

/**
 * Delete this meeting from every calendar it was mirrored to.
 *
 * Call sites (#1986): `DELETE` and the cancel branch of `PATCH`
 * `/api/meetings/[id]`, and the meeting-series purge of old generated rows —
 * all through `withdrawMeetings()` below. The interview-request cancel path
 * does not exist yet (#1844); when it lands it must go through
 * `withdrawMeetings()` as well, never delete a mirrored `Meeting` row directly.
 */
export async function removeMeeting(meetingId: string): Promise<void> {
  for (const provider of enabledSyncProviders()) {
    const links = await prisma.calendarEventLink.findMany({
      where: { meetingId, connection: { provider: provider.kind } },
      include: { connection: { select: { userId: true, calendarId: true } } },
    });
    for (const link of links) {
      const auth = await provider.accessTokenFor(link.connection.userId);
      if (auth) await provider.deleteEvent(auth, link.connection.calendarId, link.externalEventId).catch(() => {});
      // Drop our record either way: the meeting is gone from this app, and a
      // link pointing at an event we can no longer reach is worse than no link.
      await prisma.calendarEventLink.delete({ where: { id: link.id } }).catch(() => {});
    }
  }
}

/** Ceiling on a withdrawal before the caller answers anyway. */
export const CALENDAR_WITHDRAW_MS = 5_000;

/**
 * Withdraw these meetings from every calendar they were mirrored to, then
 * return — bounded by `timeoutMs`, and never rejecting.
 *
 * Awaited rather than fired and forgotten, on purpose: it has to finish BEFORE
 * the caller deletes the rows, because `GoogleCalendarEventLink` cascades away
 * with the meeting and a withdrawal with no links left to read is a no-op that
 * leaves a ghost event on someone's real calendar. Bounded instead, so a third
 * party's API can never make cancelling or deleting hang. Returns immediately
 * unless the integration is switched on.
 */
export async function withdrawMeetings(ids: string[], timeoutMs = CALENDAR_WITHDRAW_MS): Promise<void> {
  if (!anyCalendarSyncEnabled() || ids.length === 0) return;
  const work = Promise.allSettled(ids.map((id) => removeMeeting(id)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([work, deadline]);
  if (timer) clearTimeout(timer);
}

/**
 * Fire-and-forget wrapper for request handlers.
 *
 * Scheduling a meeting must not wait on — or fail because of — a third party's
 * calendar API.
 */
export function pushMeetingInBackground(meeting: PushableMeeting, userIds: string[]): void {
  if (!anyCalendarSyncEnabled()) return;
  void pushMeeting(meeting, userIds).catch((e) => console.error('Calendar push failed:', e));
}
