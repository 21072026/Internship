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

  const [byStage, mentors, interactions, meetings, rsvpGroups] = await Promise.all([
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
  ]);

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
  const rsvpTotal = (rsvp.ACCEPTED || 0) + (rsvp.DECLINED || 0) + (rsvp.PENDING || 0);
  const rsvpAcceptanceRate = rsvpTotal ? Math.round(((rsvp.ACCEPTED || 0) / rsvpTotal) * 100) : 0;

  const totalRelations = byStage.reduce((n, s) => n + s._count._all, 0);
  const hiredCount = (funnel.HIRED_660 || 0) + (funnel.EMPLOYED_700 || 0);
  const conversionToHired = totalRelations ? Math.round((hiredCount / totalRelations) * 100) : 0;

  return NextResponse.json({
    funnel,
    totalRelations,
    conversionToHired,
    mentorWorkload,
    engagement: { interactions, meetings },
    rsvp: { ...rsvp, acceptanceRate: rsvpAcceptanceRate },
  });
}
