import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { withTenantScope } from '@/lib/orgContext';
import { enforceRateLimit } from '@/lib/rateLimit';
import { prisma } from '@/lib/prisma';
import { loadAccessibleMeeting } from '@/lib/meetingAccess';
import { seriesOccurrences } from '@/lib/meetingSeriesOccurrences';

// POST — a participant says "this meeting is over" and the dashboard banner
// disappears for everyone, instead of sitting on "in progress" until the
// assumed 60-minute window (src/lib/upcomingMeeting.ts) runs out and being
// read as "they are still talking".
//
// Any participant may do it — whoever is in the call knows better than the
// clock — and it only ever *ends* a meeting: there is no un-end, because the
// banner would have died on its own within the hour anyway.
//
// Two id shapes, matching what /api/meetings/upcoming hands out:
//   - a Meeting row's cuid;
//   - `<seriesId>:<ISO instant>` for a recurring occurrence the banner
//     synthesized on the fly (no Meeting row exists to carry the mark).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limited = enforceRateLimit(request, 'meeting-end', { limit: 15, windowMs: 60_000 });
  if (limited) return limited;

  const { id: rawId } = await params;
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    /* keep the raw segment — a lone % is not worth a 500 */
  }

  return await withTenantScope(session, async () => {
    const now = new Date();
    const colon = id.indexOf(':');
    return colon > 0
      ? await endSeriesOccurrence(session.user, id.slice(0, colon), id.slice(colon + 1), now)
      : await endMeetingRow(session.user, id, now);
  });
}

async function endMeetingRow(user: { id: string; role: string }, meetingId: string, now: Date) {
  // Same participation rule as notes and call tokens; missing and not-yours
  // answer the same, so the id space stays opaque.
  const accessible = await loadAccessibleMeeting(user, meetingId);
  if (!accessible) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const row = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { scheduledAt: true, seriesId: true, endedAt: true, meetLink: true },
  });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // A link-only meeting (no time) is never "in progress", and a future one is
  // not endable — otherwise one click would silently cancel the announcement
  // everyone else is still waiting for.
  if (!row.scheduledAt || row.scheduledAt > now) {
    return NextResponse.json({ error: 'Meeting has not started' }, { status: 409 });
  }

  if (!row.endedAt) {
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { endedAt: now, endedById: user.id },
    });
    // A relation-context meeting writes one row per invited relation, all
    // sharing the (unguessable, per-event) room link — one participant ending
    // it must hide every sibling row too, or the other invitees keep seeing a
    // meeting that is over.
    if (row.meetLink) {
      await prisma.meeting.updateMany({
        where: { meetLink: row.meetLink, scheduledAt: row.scheduledAt, endedAt: null },
        data: { endedAt: now, endedById: user.id },
      });
    }
    // Generated from a recurring rule → also mark the occurrence itself, so
    // viewers who see the synthesized occurrence (not this row) lose it too.
    if (row.seriesId) {
      await prisma.meetingOccurrenceEnd.upsert({
        where: { seriesId_occurrenceAt: { seriesId: row.seriesId, occurrenceAt: row.scheduledAt } },
        update: {},
        create: { seriesId: row.seriesId, occurrenceAt: row.scheduledAt, endedById: user.id },
      });
    }
  }
  return NextResponse.json({ ok: true });
}

async function endSeriesOccurrence(user: { id: string; role: string }, seriesId: string, iso: string, now: Date) {
  const occurrenceAt = new Date(iso);
  if (Number.isNaN(occurrenceAt.getTime())) {
    return NextResponse.json({ error: 'Invalid occurrence' }, { status: 400 });
  }

  const series = await prisma.meetingSeries.findUnique({
    where: { id: seriesId },
    select: { id: true, projectId: true, createdById: true, daysOfWeek: true, timeOfDay: true, timeZone: true },
  });
  if (!series) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Who counts as a participant mirrors who the banner shows it to
  // (src/lib/upcomingMeeting.ts): project members, people whose active
  // mentorship carries the project, the rule's creator, and admins.
  let allowed = user.role === 'ADMIN' || series.createdById === user.id;
  if (!allowed && series.projectId) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: series.projectId, userId: user.id } },
      select: { id: true },
    });
    allowed = member !== null;
    if (!allowed) {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: {
          projectId: series.projectId,
          status: 'ACTIVE',
          OR: [{ mentorId: user.id }, { menteeId: user.id }],
        },
        select: { id: true },
      });
      allowed = relation !== null;
    }
  }
  if (!allowed) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Endable = actually started, recently — and a real occurrence of the rule,
  // not an arbitrary timestamp someone typed into the URL.
  if (occurrenceAt > now || now.getTime() - occurrenceAt.getTime() > 24 * 60 * 60 * 1000) {
    return NextResponse.json({ error: 'Meeting has not started' }, { status: 409 });
  }
  const minuteBefore = new Date(occurrenceAt.getTime() - 60 * 1000);
  const minuteAfter = new Date(occurrenceAt.getTime() + 60 * 1000);
  const real = seriesOccurrences(series.daysOfWeek, series.timeOfDay, minuteBefore, minuteAfter, series.timeZone).some(
    (d) => d.getTime() === occurrenceAt.getTime()
  );
  if (!real) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.meetingOccurrenceEnd.upsert({
    where: { seriesId_occurrenceAt: { seriesId, occurrenceAt } },
    update: {},
    create: { seriesId, occurrenceAt, endedById: user.id },
  });
  // If the reminder cron already materialized this occurrence as Meeting rows,
  // mark those too — other members may be looking at the row, not the rule.
  await prisma.meeting.updateMany({
    where: { seriesId, scheduledAt: occurrenceAt, endedAt: null },
    data: { endedAt: now, endedById: user.id },
  });
  return NextResponse.json({ ok: true });
}
