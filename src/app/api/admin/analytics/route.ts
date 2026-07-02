import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — aggregate analytics for the admin dashboard:
// pipeline funnel, mentor workload/outcomes, engagement and RSVP rate.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Last 6 calendar months (inclusive), oldest first, as YYYY-MM keys.
  const now = new Date();
  const months: string[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const since = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

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
    prisma.interactionLog.count(),
    prisma.meeting.count(),
    prisma.meeting.groupBy({ by: ['rsvp'], _count: { _all: true } }),
    prisma.project.findMany({ select: { name: true, _count: { select: { relations: true } } } }),
    prisma.mentorshipRelation.findMany({ where: { startDate: { gte: since } }, select: { startDate: true } }),
    prisma.interactionLog.findMany({ where: { date: { gte: since } }, select: { date: true } }),
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
  });
}
