import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { buildFeedIcs } from '@/lib/ics';
import { enforceRateLimit } from '@/lib/rateLimit';
import { seriesOccurrences } from '@/lib/meetingSeriesOccurrences';
import { pipelineLabel } from '@/lib/pipeline';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Overall event cap, kept from #915 and applied to the whole fan-out, not per query. */
const MAX_EVENTS = 500;

// GET — personal ICS subscription feed (#915). Public by design (calendar apps
// can't log in); the unguessable per-user token from /api/account/ics-feed is
// the credential and can be rotated/revoked there. Deliberately PII-minimal:
// each event carries a title and a time, nothing else — no join links, no
// participant names — so a leaked URL exposes as little as possible.
//
// Since #2015 the feed carries everything the in-app calendar shows, scoped by
// role exactly as /api/calendar-events does: relation meetings, project and
// conversation meetings the user belongs to, recurring series occurrences and
// stage deadlines. The title-and-time-only rule survives that widening — the
// selects below deliberately fetch no name, no link and no project.
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const limited = enforceRateLimit(request, 'ics-feed', { limit: 60, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;

  const { token } = await params;
  const user = await prisma.user.findUnique({ where: { icsFeedToken: token }, select: { id: true, role: true } });
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // A window from 30 days back (context) to everything scheduled ahead. A
  // recurring rule has no last occurrence, so its expansion needs a finite
  // upper edge — the same 275-day default /api/calendar-events expands over.
  const since = new Date(Date.now() - 30 * DAY_MS);
  const until = new Date(Date.now() + 275 * DAY_MS);
  // A MENTOR is matched on *both* sides, not just `mentorId`: promoting a mentee
  // to mentor flips User.role in place and keeps every relation they hold as a
  // mentee, and the feed before #2015 matched either side for everyone. Scoping
  // to `mentorId` alone would silently drop their own internship meetings and
  // deadline from a calendar they had already subscribed to.
  const relWhere: Prisma.MentorshipRelationWhereInput =
    user.role === 'ADMIN'
      ? {}
      : user.role === 'MENTOR'
        ? { OR: [{ mentorId: user.id }, { menteeId: user.id }] }
        : { menteeId: user.id };

  const [meetings, teamMeetings, series, relations] = await Promise.all([
    // The user's own meetings, on either side of a relation. `seriesId: null`
    // drops the rows the old materialising generator left behind — the
    // occurrence is rendered from the rule below, and listing both double-books
    // the day (the same exclusion /api/calendar-events makes, #1110).
    prisma.meeting.findMany({
      where: { relationId: { not: null }, seriesId: null, scheduledAt: { not: null, gte: since }, relation: relWhere },
      select: { id: true, title: true, scheduledAt: true },
      orderBy: { scheduledAt: 'asc' },
      take: MAX_EVENTS,
    }),
    // Meetings that hang off a project or a conversation instead of a relation
    // (#1051) — membership is the scoping here, since there is no mentor/mentee
    // side to filter on.
    prisma.meeting.findMany({
      where: {
        scheduledAt: { not: null, gte: since },
        OR: [
          { project: { members: { some: { userId: user.id } } } },
          { conversation: { participants: { some: { userId: user.id } } } },
        ],
      },
      select: { id: true, title: true, scheduledAt: true },
      orderBy: { scheduledAt: 'asc' },
      take: MAX_EVENTS,
    }),
    // The recurring project meetings this user is expected at, scoped as in
    // /api/calendar-events. `fixedLink` and the project name are deliberately
    // not selected: neither may reach the feed.
    prisma.meetingSeries.findMany({
      where: {
        active: true,
        projectId: { not: null },
        ...(user.role === 'ADMIN'
          ? {}
          : {
              project: {
                OR: [
                  { members: { some: { userId: user.id } } },
                  { relations: { some: { ...relWhere, status: 'ACTIVE' } } },
                ],
              },
            }),
      },
      select: { id: true, title: true, daysOfWeek: true, timeOfDay: true, timeZone: true },
      // Deliberately uncapped: one rule expands into hundreds of occurrences, so
      // a cap here would drop whole recurring calls rather than trim the tail —
      // the MAX_EVENTS budget is applied once, to the merged event list below.
      orderBy: { createdAt: 'asc' },
    }),
    // Stage deadlines. No mentee relation is selected at all, so a participant
    // name cannot leak into the title by accident.
    prisma.mentorshipRelation.findMany({
      where: { ...relWhere, stageDeadline: { not: null, gte: since } },
      select: { id: true, pipelineStatus: true, stageDeadline: true },
      // Soonest first, so a cap that bites keeps the deadlines that matter. An
      // ADMIN's `relWhere` is `{}`, so without an order MySQL would hand back an
      // arbitrary 500 rows and a deadline three days out could lose to one six
      // months out.
      orderBy: { stageDeadline: 'asc' },
      take: MAX_EVENTS,
    }),
  ]);

  const events = [
    ...meetings.map((m) => ({ uid: m.id, title: m.title, start: m.scheduledAt! })),
    ...teamMeetings.map((m) => ({ uid: m.id, title: m.title, start: m.scheduledAt! })),
    // The same synthetic id /api/calendar-events (and the series invite mail)
    // uses, so a subscribed client and the app agree on which occurrence is
    // which instead of showing it twice.
    ...series.flatMap((s) =>
      seriesOccurrences(s.daysOfWeek, s.timeOfDay, since, until, s.timeZone).map((when) => ({
        uid: `series-${s.id}-${when.toISOString()}`,
        title: s.title,
        start: when,
      }))
    ),
    // The feed has no locale to read, so the stage label falls back to English.
    ...relations.map((r) => ({
      uid: `deadline-${r.id}`,
      title: pipelineLabel(r.pipelineStatus),
      start: r.stageDeadline!,
    })),
  ]
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, MAX_EVENTS);

  const ics = buildFeedIcs('InternshipCRM', events);
  return new NextResponse(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="internship-crm.ics"',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
