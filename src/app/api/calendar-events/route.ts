import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { withTenantScope } from '@/lib/orgContext';

// Stages that are terminal — an overdue deadline on these is not actionable.
const TERMINAL = ['HIRED_660', 'EMPLOYED_700', 'INTERNSHIP_FOUND_ELSEWHERE_800'];

// GET — calendar events (meetings + stage deadlines) visible to the caller,
// scoped by role. Returns a flat list the month view can bucket by day.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const { id, role } = session.user;
  const relWhere: Prisma.MentorshipRelationWhereInput =
    role === 'ADMIN' ? {} : role === 'MENTOR' ? { mentorId: id } : { menteeId: id };

  const [meetings, relations, loggedMeetings] = await Promise.all([
    prisma.meeting.findMany({
      where: { relation: relWhere },
      include: { relation: { include: { mentee: { select: { fullName: true } } } } },
      orderBy: { scheduledAt: 'asc' },
    }),
    prisma.mentorshipRelation.findMany({
      where: { ...relWhere, stageDeadline: { not: null } },
      include: { mentee: { select: { fullName: true } } },
    }),
    // Logged "Meeting" interactions are past meetings a mentor recorded without
    // going through the scheduling flow — surface them so the calendar isn't
    // empty when the team logs meetings as interactions instead.
    prisma.interactionLog.findMany({
      where: { type: 'Meeting', relation: relWhere },
      include: { relation: { include: { mentee: { select: { fullName: true } } } } },
      orderBy: { date: 'asc' },
    }),
  ]);

  const events = [
    // No-time meetings (nullable scheduledAt) don't belong on a calendar.
    ...meetings.filter((m) => m.scheduledAt).map((m) => ({
      id: `meeting-${m.id}`,
      type: 'meeting' as const,
      title: m.title,
      who: m.relation.mentee.fullName,
      date: m.scheduledAt!.toISOString(),
      link: m.meetLink ?? null,
    })),
    ...loggedMeetings.map((i) => ({
      id: `logged-${i.id}`,
      type: 'logged' as const,
      title: i.notes.slice(0, 80) || 'Meeting',
      who: i.relation.mentee.fullName,
      date: i.date.toISOString(),
      link:
        role === 'ADMIN'
          ? `/admin/candidates/${i.relation.menteeId}`
          : role === 'MENTOR'
            ? `/mentor/mentees/${i.relationId}`
            : null,
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
  });
}
