import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// GET — mentor-scoped analytics: their own pipeline funnel, goal summary and
// engagement stats (EPIC: mentor analytics / pipeline funnel, roadmap #370).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'MENTOR' && session.user.role !== 'ADMIN')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    // A MENTOR sees only their own mentees; an ADMIN sees all (no mentor filter),
    // mirroring the company analytics route.
    const relationWhere = session.user.role === 'ADMIN' ? {} : { mentorId: session.user.id };
    const interactionWhere =
      session.user.role === 'ADMIN' ? {} : { relation: { mentorId: session.user.id } };

    const [relations, interactions, goals] = await Promise.all([
      prisma.mentorshipRelation.findMany({
        where: relationWhere,
        select: {
          id: true,
          status: true,
          pipelineStatus: true,
          startDate: true,
          mentee: { select: { id: true, fullName: true } },
          statusChanges: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, createdAt: true } },
        },
      }),
      prisma.interactionLog.count({ where: interactionWhere }),
      prisma.goal.findMany({
        where: interactionWhere,
        select: { status: true, completedAt: true },
      }),
    ]);

    // Pipeline funnel: count mentees per stage (all relations, not just active).
    const funnel: Record<string, number> = {};
    for (const r of relations) {
      funnel[r.pipelineStatus] = (funnel[r.pipelineStatus] ?? 0) + 1;
    }

    const totalRelations = relations.length;
    const activeRelations = relations.filter((r) => r.status === 'ACTIVE').length;
    const hired = relations.filter(
      (r) => r.pipelineStatus === 'HIRED_660' || r.pipelineStatus === 'EMPLOYED_700'
    ).length;
    const conversionToHired = totalRelations > 0 ? Math.round((hired / totalRelations) * 100) : 0;

    // Goal summary across all mentees.
    const goalsOpen = goals.filter((g) => g.status === 'OPEN').length;
    const goalsDone = goals.filter((g) => g.status === 'DONE').length;
    const goalsTotal = goals.length;

    // Average days to hired for completed mentees.
    let avgDaysToHired: number | null = null;
    const hiredRelations = relations.filter(
      (r) => r.pipelineStatus === 'HIRED_660' || r.pipelineStatus === 'EMPLOYED_700'
    );
    if (hiredRelations.length > 0) {
      const durations = hiredRelations
        .map((r) => {
          const last = r.statusChanges[r.statusChanges.length - 1];
          if (!last) return null;
          return Math.floor((last.createdAt.getTime() - r.startDate.getTime()) / (24 * 60 * 60 * 1000));
        })
        .filter((d): d is number => d !== null);
      if (durations.length > 0) {
        avgDaysToHired = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
      }
    }

    return NextResponse.json({
      funnel,
      totalRelations,
      activeRelations,
      hired,
      conversionToHired,
      interactions,
      goals: { open: goalsOpen, done: goalsDone, total: goalsTotal },
      avgDaysToHired,
    });
  });
}
