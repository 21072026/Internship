import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

// Stages that are terminal — an overdue deadline on these is not actionable.
const TERMINAL = ['HIRED_660', 'EMPLOYED_700', 'INTERNSHIP_FOUND_ELSEWHERE_800'];

// GET — calendar events (meetings + stage deadlines) visible to the caller,
// scoped by role. Returns a flat list the month view can bucket by day.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, role } = session.user;
  const relWhere: Prisma.MentorshipRelationWhereInput =
    role === 'ADMIN' ? {} : role === 'MENTOR' ? { mentorId: id } : { menteeId: id };

  const [meetings, relations] = await Promise.all([
    prisma.meeting.findMany({
      where: { relation: relWhere },
      include: { relation: { include: { mentee: { select: { fullName: true } } } } },
      orderBy: { scheduledAt: 'asc' },
    }),
    prisma.mentorshipRelation.findMany({
      where: { ...relWhere, stageDeadline: { not: null } },
      include: { mentee: { select: { fullName: true } } },
    }),
  ]);

  const events = [
    ...meetings.map((m) => ({
      id: `meeting-${m.id}`,
      type: 'meeting' as const,
      title: m.title,
      who: m.relation.mentee.fullName,
      date: m.scheduledAt.toISOString(),
      link: m.meetLink ?? null,
    })),
    ...relations.map((r) => ({
      id: `deadline-${r.id}`,
      type: 'deadline' as const,
      title: r.pipelineStatus,
      who: r.mentee.fullName,
      date: r.stageDeadline!.toISOString(),
      overdue: r.stageDeadline! < new Date() && !TERMINAL.includes(r.pipelineStatus),
      link: `/admin/candidates/${r.menteeId}`,
    })),
  ];

  return NextResponse.json({ events });
}
