import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { onPathKeys } from '@/lib/pipeline';
import { biggestDropOff, stageConversions, timeToHire, type Journey } from '@/lib/funnelKpi';
import { getMentorAvailability } from '@/lib/mentorAvailability';

// Hiring-funnel KPIs (#815): the two numbers HR reports upward — stage-to-stage
// conversion and time-to-hire — plus mentor capacity, all from the StatusChange
// audit trail the aging report already reads.
//
// The stage ORDER comes from the tenant's own pipeline configuration (#747), so
// a custom stage set converts correctly and no key like 'HIRED_660' is assumed
// to exist. What counts as "finished" is the last on-path stage of that order,
// and its key is returned so the screen can name it rather than implying a
// universal definition of "hired".
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    // Optional window: a journey counts when it STARTED inside it. Filtering by
    // "finished inside the window" would silently select for fast journeys —
    // the slow ones simply have not finished yet — and report a time-to-hire
    // that is too good.
    const { searchParams } = new URL(request.url);
    const parseDate = (v: string | null): Date | null => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const from = parseDate(searchParams.get('from'));
    const to = parseDate(searchParams.get('to'));
    const rangeOk = from && to && from.getTime() <= to.getTime();

    const relations = await prisma.mentorshipRelation.findMany({
      where: rangeOk ? { startDate: { gte: from!, lte: to! } } : {},
      select: {
        id: true,
        pipelineStatus: true,
        startDate: true,
        statusChanges: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, createdAt: true } },
      },
    });

    const stages = await resolvePipelineStages((session.user as { orgId?: string | null }).orgId ?? null);
    const order = onPathKeys(stages);

    const journeys: Journey[] = relations.map((r) => ({
      // Where the journey began: the stage the first recorded move came FROM,
      // else — for a relation that never moved — where it sits now.
      startStatus: r.statusChanges[0]?.fromStatus ?? r.pipelineStatus,
      startedAt: r.startDate.getTime(),
      changes: r.statusChanges.map((c) => ({ toStatus: c.toStatus, at: c.createdAt.getTime() })),
    }));

    const conversions = stageConversions(order, journeys);
    const tth = timeToHire(order, journeys);

    // Mentor capacity, derived through the SAME function the mentor's own
    // screen and the admin assignment dialog use (#941/#942), so this report
    // can never contradict the badge shown next to a mentor's name.
    const mentors = await prisma.user.findMany({
      where: { role: { in: ['MENTOR', 'ADMIN'] }, isActive: true },
      select: {
        id: true,
        fullName: true,
        mentorCapacity: true,
        acceptingMentees: true,
        _count: { select: { mentorRelations: { where: { status: 'ACTIVE' } } } },
      },
    });
    const capacity = mentors
      .map((m) => {
        const activeMenteeCount = m._count.mentorRelations;
        const availability = getMentorAvailability({
          mentorCapacity: m.mentorCapacity,
          activeMenteeCount,
          acceptingMentees: m.acceptingMentees,
        });
        return {
          id: m.id,
          fullName: m.fullName,
          activeMenteeCount,
          mentorCapacity: m.mentorCapacity,
          status: availability.status,
          capacityKnown: availability.capacityKnown,
          // Genuinely past the ceiling, not merely at it — the report's job is
          // to surface the ones carrying more than they agreed to.
          overloaded: m.mentorCapacity != null && activeMenteeCount > m.mentorCapacity,
        };
      })
      .sort((a, b) => b.activeMenteeCount - a.activeMenteeCount);

    return NextResponse.json({
      order,
      conversions,
      biggestDropOff: biggestDropOff(conversions),
      timeToHire: tth,
      capacity,
      // Echoed so the screen can say which journeys these numbers describe.
      journeys: journeys.length,
    });
  });
}
