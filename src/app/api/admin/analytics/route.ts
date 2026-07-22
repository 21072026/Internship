import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// GET — aggregate analytics for the admin dashboard:
// pipeline funnel, mentor workload/outcomes, engagement and RSVP rate.
//
// Time-scoped metrics (trends, engagement counts, RSVP) honour an optional
// ?from=YYYY-MM-DD&to=YYYY-MM-DD date-range window. Defaults to the last 6
// calendar months. The funnel / mentor / project distributions are current
// pipeline state, so they are intentionally NOT date-filtered.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
  const { searchParams } = new URL(request.url);
  const now = new Date();
  const parseDate = (v: string | null): Date | null => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  // Range: default from = start of the month 5 months ago; to = now. If the
  // client sends bad/inverted dates we fall back to the default rather than 500.
  const to = parseDate(searchParams.get('to')) ?? now;
  const defaultFrom = new Date(to.getFullYear(), to.getMonth() - 5, 1);
  let from = parseDate(searchParams.get('from')) ?? defaultFrom;
  if (from.getTime() > to.getTime()) from = defaultFrom;

  // Monthly buckets spanning [from, to], oldest first, as YYYY-MM keys.
  // Capped at 24 buckets so a huge range can't produce an unwieldy chart.
  const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const months: string[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cursor.getTime() <= end.getTime() && months.length < 24) {
    months.push(monthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  const inRange = { gte: from, lte: to };

  const [byStage, mentors, interactions, meetings, rsvpGroups, projectRows, relDates, interactionDates] = await Promise.all([
    prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], _count: { _all: true } }),
    prisma.user.findMany({
      where: { role: 'MENTOR' },
      select: {
        id: true,
        fullName: true,
        mentorRelations: { select: { pipelineStatus: true } },
      },
    }),
    prisma.interactionLog.count({ where: { date: inRange } }),
    prisma.meeting.count({ where: { scheduledAt: inRange } }),
    prisma.meeting.groupBy({ by: ['rsvp'], where: { scheduledAt: inRange }, _count: { _all: true } }),
    prisma.project.findMany({ select: { name: true, _count: { select: { relations: true } } } }),
    prisma.mentorshipRelation.findMany({ where: { startDate: inRange }, select: { startDate: true } }),
    prisma.interactionLog.findMany({ where: { date: inRange }, select: { date: true } }),
  ]);

  // Monthly trend buckets.
  const newRelationsByMonth: Record<string, number> = Object.fromEntries(months.map((m) => [m, 0]));
  for (const r of relDates) { const k = monthKey(r.startDate); if (k in newRelationsByMonth) newRelationsByMonth[k]++; }
  const interactionsByMonth: Record<string, number> = Object.fromEntries(months.map((m) => [m, 0]));
  for (const it of interactionDates) { const k = monthKey(it.date); if (k in interactionsByMonth) interactionsByMonth[k]++; }
  const trends = {
    months,
    newRelations: months.map((m) => newRelationsByMonth[m]),
    interactions: months.map((m) => interactionsByMonth[m]),
  };
  const range = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };

  const projectWorkload = projectRows
    .map((p) => ({ name: p.name, interns: p._count.relations }))
    .sort((a, b) => b.interns - a.interns)
    .slice(0, 10);

  const funnel = Object.fromEntries(byStage.map((s) => [s.pipelineStatus, s._count._all]));

  const HIRED = new Set(['HIRED_660', 'EMPLOYED_700']);
  const mentorWorkload = mentors
    .map((m) => ({
      id: m.id,
      fullName: m.fullName,
      active: m.mentorRelations.length,
      hired: m.mentorRelations.filter((r) => HIRED.has(r.pipelineStatus)).length,
    }))
    .sort((a, b) => b.active - a.active);

  const rsvp = Object.fromEntries(rsvpGroups.map((g) => [g.rsvp, g._count._all]));
  // Acceptance rate is over those who actually responded (accepted + declined).
  // Pending invites shouldn't drag the rate down, and with no responses at all
  // the rate is null (rendered as "—") rather than a misleading 0%.
  const rsvpResponded = (rsvp.ACCEPTED || 0) + (rsvp.DECLINED || 0);
  const rsvpAcceptanceRate = rsvpResponded ? Math.round(((rsvp.ACCEPTED || 0) / rsvpResponded) * 100) : null;

  const totalRelations = byStage.reduce((n, s) => n + s._count._all, 0);
  const hiredCount = (funnel.HIRED_660 || 0) + (funnel.EMPLOYED_700 || 0);
  const conversionToHired = totalRelations ? Math.round((hiredCount / totalRelations) * 100) : 0;

  return NextResponse.json({
    funnel,
    totalRelations,
    conversionToHired,
    mentorWorkload,
    projectWorkload,
    engagement: { interactions, meetings },
    rsvp: { ...rsvp, responded: rsvpResponded, acceptanceRate: rsvpAcceptanceRate },
    trends,
    range,
  });
  });
}
