import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withRequestScope } from '@/lib/requestContext';
import { withTenantScope } from '@/lib/orgContext';
import { salesPoolGate } from '@/lib/salesPoolGate';
import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { isNextActionOverdue } from '@/lib/nextActionRule';
import { salesLeadHref } from '@/lib/salesSurface';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Widest window one request may ask for — a month grid is 42 days. */
const MAX_RANGE_DAYS = 62;
/** Per kind, so a crowded book cannot turn one request into a scan. */
const MAX_PER_KIND = 500;

/** The UTC calendar day a date-only column stands for, as `YYYY-MM-DD`. */
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

// GET ?from=&to= — the sales rep's calendar (#3778): what is on THEIR book in
// the window on screen.
//
//   meeting  — a scheduled meeting on one of their records (relation meetings,
//              the same rows /api/calendar-events lists for a mentor);
//   followup — a record's follow-up day (`nextActionAt`, #2563), overdue by the
//              one rule the panel, the reminder and the queue share;
//   trial    — a running trial's end day (`trialEndsAt`, #2553).
//
// MARKETING sales surface only, the caller's own org only — the same door as
// the lead pool (salesPoolGate). The scope is the rep's own records
// (`mentorId = self` inside the org), written into every query: the team view
// waits for the shared sales-book read rule rather than growing a second one
// here. A follow-up and a trial end are DAYS, not instants, so they travel as
// `YYYY-MM-DD` with `allDay` and are placed on that day whatever the viewer's
// zone; a meeting is an instant the browser renders on its own clock.
export async function GET(request: Request) {
  return withRequestScope(request, async () => {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const g = await salesPoolGate(session);
    if (!g.ok) return g.response;

    const url = new URL(request.url);
    const from = rangeStart(url.searchParams.get('from'));
    let to = rangeEnd(url.searchParams.get('to'));
    if (!from || !to || to < from) {
      return NextResponse.json({ error: 'Validation failed', code: 'invalid_range' }, { status: 400 });
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) to = new Date(from.getTime() + MAX_RANGE_DAYS * DAY_MS);
    // Date-only columns are stored at UTC midnight: widen the window by a day on
    // each side so a day at the edge of the viewer's local range is not lost to
    // the offset; the browser buckets by the day string anyway.
    const dayFrom = new Date(from.getTime() - DAY_MS);
    const dayTo = new Date(to.getTime() + DAY_MS);

    return withTenantScope(session, async () => {
      const lead = { mentee: { select: { fullName: true } } } as const;
      const [meetings, followUps, trials] = await Promise.all([
        prisma.meeting.findMany({
          where: {
            seriesId: null,
            status: 'SCHEDULED',
            scheduledAt: { gte: from, lte: to },
            relation: { is: { orgId: g.orgId, mentorId: g.userId } },
          },
          select: { id: true, title: true, scheduledAt: true, durationMinutes: true, relationId: true, relation: { select: lead } },
          orderBy: { scheduledAt: 'asc' },
          take: MAX_PER_KIND,
        }),
        prisma.mentorshipRelation.findMany({
          where: { orgId: g.orgId, mentorId: g.userId, status: 'ACTIVE', nextActionAt: { gte: dayFrom, lte: dayTo } },
          select: { id: true, nextActionAt: true, nextActionNote: true, ...lead },
          orderBy: { nextActionAt: 'asc' },
          take: MAX_PER_KIND,
        }),
        prisma.mentorshipRelation.findMany({
          where: { orgId: g.orgId, mentorId: g.userId, status: 'ACTIVE', trialEndsAt: { gte: dayFrom, lte: dayTo } },
          select: { id: true, trialEndsAt: true, ...lead },
          orderBy: { trialEndsAt: 'asc' },
          take: MAX_PER_KIND,
        }),
      ]);

      const now = Date.now();
      const events = [
        ...meetings
          .filter((m) => m.scheduledAt && m.relationId && m.relation)
          .map((m) => ({
            id: `meeting-${m.id}`,
            type: 'meeting' as const,
            title: m.title,
            who: m.relation!.mentee.fullName,
            date: m.scheduledAt!.toISOString(),
            durationMinutes: m.durationMinutes ?? null,
            link: salesLeadHref(m.relationId!),
          })),
        ...followUps.map((r) => ({
          id: `followup-${r.id}`,
          type: 'followup' as const,
          title: r.nextActionNote ?? '',
          who: r.mentee.fullName,
          date: utcDay(r.nextActionAt!),
          allDay: true,
          overdue: isNextActionOverdue(r.nextActionAt!, now),
          link: salesLeadHref(r.id),
        })),
        ...trials.map((r) => ({
          id: `trial-${r.id}`,
          type: 'trial' as const,
          title: '',
          who: r.mentee.fullName,
          date: utcDay(r.trialEndsAt!),
          allDay: true,
          link: salesLeadHref(r.id),
        })),
      ].sort((a, b) => a.date.localeCompare(b.date));

      return NextResponse.json({ events, from: from.toISOString(), to: to.toISOString() });
    });
  });
}
