import { prisma } from '@/lib/prisma';
import { isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { accessTokenFor, calendarFetch, noteError } from '@/lib/googleCalendarClient';
import { CALENDAR_WITHDRAW_MS } from '@/lib/googleCalendarSync';
import { meetingEnd } from '@/lib/meetingDuration';
import { nextRuleOccurrence, parseDaysOfWeek } from '@/lib/meetingSeriesOccurrences';
import { lastMeetingDay, type SeriesCadence } from '@/lib/seriesRule';
import { resolveTimeZone } from '@/lib/timezone';
import { weeklyRrule } from '@/lib/seriesRrule';

/**
 * A recurring project meeting on its members' own Google Calendars (#2654).
 *
 * A `MeetingSeries` is a rule, not rows (#1110): its occurrences are expanded on
 * the fly and have no `Meeting` row, so `pushMeeting()` had nothing to push and
 * a weekly project call never reached anybody's calendar. The mirror is ONE
 * recurring event per connected member, carrying an RRULE, and it is keyed by
 * `GoogleCalendarEventLink.seriesId`. Occurrences are NEVER materialised to
 * make this work, because that is the ghost-row bug #1110 removed.
 *
 * `syncSeries()` reconciles, it does not just push. The audience is the
 * project's members, and a series can change project, lose members or be
 * cancelled, so every call brings the calendars to the series' current state:
 * an active series is POSTed (or PATCHed on the event it already made) for
 * every connected member, and every other link is withdrawn.
 *
 * The same promise as the one-off mirror (googleCalendarSync.ts): a no-op unless
 * the integration is switched on and the person connected, and a failure is
 * recorded on the connection and never surfaces to whoever saved the series.
 */

export interface SyncableSeries extends SeriesCadence {
  id: string;
  projectId: string | null;
  title: string;
  daysOfWeek: unknown;
  timeOfDay: string;
  timeZone: string | null;
  durationMinutes: number | null;
  fixedLink: string | null;
  active: boolean;
}

function eventBody(series: SyncableSeries, first: Date, rrule: string) {
  // Google requires a zone on a recurring event: BYDAY and the wall clock are
  // read in it, which is what keeps 09:00 at 09:00 across a DST change.
  const timeZone = resolveTimeZone(series.timeZone);
  return {
    summary: series.title,
    description: series.fixedLink ? `Join: ${series.fixedLink}` : undefined,
    location: series.fixedLink ?? undefined,
    start: { dateTime: first.toISOString(), timeZone },
    end: { dateTime: meetingEnd(first, series).toISOString(), timeZone },
    recurrence: [rrule],
    source: { title: 'Internship CRM', url: series.fixedLink ?? undefined },
  };
}

async function audienceOf(series: SyncableSeries): Promise<string[]> {
  if (!series.projectId) return [];
  const members = await prisma.projectMember.findMany({
    where: { projectId: series.projectId },
    select: { userId: true },
  });
  return [...new Set(members.map((m) => m.userId))];
}

async function deleteLink(link: { id: string; googleEventId: string; connection: { userId: string; calendarId: string } }) {
  const auth = await accessTokenFor(link.connection.userId);
  if (auth) {
    await calendarFetch(
      auth.token,
      `/calendars/${encodeURIComponent(link.connection.calendarId)}/events/${encodeURIComponent(link.googleEventId)}`,
      { method: 'DELETE' },
    ).catch(() => null);
  }
  // Dropped either way, for the reason removeMeeting() gives: a link to an
  // event we can no longer reach is worse than no link.
  await prisma.googleCalendarEventLink.delete({ where: { id: link.id } }).catch(() => {});
}

/**
 * Bring every connected member's calendar to the series' current state. Returns
 * how many events were written (created or updated).
 */
export async function syncSeries(series: SyncableSeries): Promise<number> {
  if (!isGoogleCalendarEnabled()) return 0;

  const rrule = weeklyRrule(series.daysOfWeek, {
    intervalWeeks: series.intervalWeeks,
    lastDay: lastMeetingDay(parseDaysOfWeek(series.daysOfWeek), series),
  });
  // The next REAL occurrence (#2013): a meeting week of the cadence, before its
  // end — or none, and the calendars are withdrawn below.
  const first = series.active && rrule ? nextRuleOccurrence(series) : null;
  const audience = first ? await audienceOf(series) : [];

  let pushed = 0;
  const kept = new Set<string>();
  for (const userId of audience) {
    const auth = await accessTokenFor(userId);
    if (!auth) continue;
    kept.add(auth.connectionId);

    const link = await prisma.googleCalendarEventLink.findUnique({
      where: { seriesId_connectionId: { seriesId: series.id, connectionId: auth.connectionId } },
    });
    const path = `/calendars/${encodeURIComponent(auth.calendarId)}/events${link ? `/${encodeURIComponent(link.googleEventId)}` : ''}`;
    const res = await calendarFetch(auth.token, path, {
      method: link ? 'PATCH' : 'POST',
      body: JSON.stringify(eventBody(series, first!, rrule!)),
    }).catch(() => null);

    if (!res || !res.ok) {
      await noteError(auth.connectionId, res ? `Calendar write failed (${res.status})` : 'Calendar write failed');
      // A remembered event Google no longer has: forget it, so the next sync
      // creates a fresh one instead of patching a ghost.
      if (res?.status === 404 && link) {
        await prisma.googleCalendarEventLink.delete({ where: { id: link.id } }).catch(() => {});
      }
      continue;
    }

    const eventId = typeof res.body.id === 'string' ? res.body.id : link?.googleEventId;
    if (eventId) {
      await prisma.googleCalendarEventLink.upsert({
        where: { seriesId_connectionId: { seriesId: series.id, connectionId: auth.connectionId } },
        update: { googleEventId: eventId, pushedAt: new Date() },
        create: { seriesId: series.id, connectionId: auth.connectionId, googleEventId: eventId },
      });
    }
    await prisma.googleCalendarConnection
      .update({ where: { id: auth.connectionId }, data: { lastSyncAt: new Date(), lastError: null } })
      .catch(() => {});
    pushed++;
  }

  // Everyone the series no longer reaches: cancelled, moved to another project,
  // removed from this one, or a rule with no weekday left.
  const stale = await prisma.googleCalendarEventLink.findMany({
    where: { seriesId: series.id, ...(kept.size > 0 ? { connectionId: { notIn: [...kept] } } : {}) },
    include: { connection: { select: { userId: true, calendarId: true } } },
  });
  for (const link of stale) await deleteLink(link);

  return pushed;
}

/**
 * The same reconciliation, bounded by `timeoutMs` and never rejecting. The
 * series save awaits it only on a cancel (a DELETE, or a PUT to inactive), so
 * the withdrawal has run before the caller answers, as `withdrawMeetings()`
 * does. A calendar that does not answer never makes a save hang.
 */
export async function syncSeriesBounded(series: SyncableSeries, timeoutMs = CALENDAR_WITHDRAW_MS): Promise<void> {
  if (!isGoogleCalendarEnabled()) return;
  const work = syncSeries(series).catch((e) => console.error('Google Calendar series sync failed:', e));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([work, deadline]);
  if (timer) clearTimeout(timer);
}

/** Fire-and-forget, for a create or a schedule change: the save never waits on Google. */
export function syncSeriesInBackground(series: SyncableSeries): void {
  if (!isGoogleCalendarEnabled()) return;
  void syncSeries(series).catch((e) => console.error('Google Calendar series sync failed:', e));
}
