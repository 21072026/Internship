import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolvePipelineStages, outcomeStageKeysFrom } from '@/lib/pipelineStages';
import { onPathKeys } from '@/lib/pipeline';
import {
  biggestDropOff,
  cohortMonths,
  conversionByEntryMonth,
  DEFAULT_RETENTION_BUCKETS,
  retentionTriangle,
  stageConversions,
  timeToHire,
  type Journey,
} from '@/lib/funnelKpi';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { shellCapabilities } from '@/lib/shellCapabilities';

// Hiring-funnel KPIs (#815): the two numbers HR reports upward — stage-to-stage
// conversion and time-to-hire — plus mentor capacity, all from the StatusChange
// audit trail the aging report already reads.
//
// The stage ORDER comes from the tenant's own pipeline configuration (#747), so
// a custom stage set converts correctly and no key like 'HIRED_660' is assumed
// to exist. What counts as "finished" is the last on-path stage of that order,
// and its key is returned so the screen can name it rather than implying a
// universal definition of "hired".

// Mentor capacity, derived through the SAME function the mentor's own screen
// and the admin assignment dialog use (#941/#942), so this report can never
// contradict the badge shown next to a mentor's name. Lifted out of the handler
// (#2423) so it is only *called* for a vertical that carries mentors at all; it
// still runs inside the caller's tenant scope, which the async context carries.
async function mentorCapacity() {
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
  return mentors
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
}

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

    const orgId = (session.user as { orgId?: string | null }).orgId ?? null;
    const [stages, capabilities] = await Promise.all([resolvePipelineStages(orgId), shellCapabilities(orgId)]);
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

    // Cohorts (#2420 / #2425). Both read the SAME `journeys` the two numbers
    // above are computed from — there is one mapping of StatusChange rows to
    // journeys in this route and everything on the card agrees because of it.
    //
    // Which stages: the tenant's own, resolved through the #1882 outcome rule
    // rather than named. `first` is the stage a record starts on, so "entry
    // month" is the month it arrived; `finished` is what this tenant means by
    // won (for the built-in catalogue HIRED_660 *and* EMPLOYED_700, which is
    // exactly the set "the last on-path key" would get wrong); `offPath` is
    // what it means by lost, so a stage merely deleted from the set later is
    // never read as a customer leaving.
    const outcome = outcomeStageKeysFrom(stages);
    const toKey = outcome.finished[0] ?? null;
    // The months to report. With no range the screen is showing everything, so
    // the cohorts cover the last twelve months — long enough for the widest
    // retention bucket to have closed for at least one row.
    //
    // The POPULATION is still the one the whole card describes: journeys that
    // STARTED inside the window (see the query above). So a lead that arrived
    // before the window and won inside it is in neither the cohort rows nor
    // the conversion rows — deliberately, because a card whose sections each
    // answered for a different set of records is worse than one that answers
    // for a stated set. Widen the range to widen the population.
    const windowEnd = to ?? new Date();
    const windowStart =
      rangeOk && from
        ? from
        : new Date(Date.UTC(windowEnd.getUTCFullYear(), windowEnd.getUTCMonth() - 11, 1));
    const months = cohortMonths(windowStart, windowEnd);

    const cohortConversion = {
      fromKey: outcome.first,
      toKey,
      // No won stage at all (a set with no on-path stage) leaves the months in
      // place with null rates rather than dropping the section to an empty
      // array, so the screen renders the same shape either way.
      months: conversionByEntryMonth(order, journeys, outcome.first, toKey ?? '', months),
    };
    const retention = {
      wonKeys: outcome.finished,
      wonLabel: outcome.finishedLabel,
      buckets: DEFAULT_RETENTION_BUCKETS,
      cohorts: retentionTriangle(order, journeys, months, DEFAULT_RETENTION_BUCKETS, {
        wonKeys: outcome.finished,
        offPath: outcome.offPath,
      }),
    };

    // Mentor capacity — only for a vertical that has mentors at all (#2423). A
    // MARKETING org's ADMIN/MENTOR rows are reps, and measuring them against a
    // "mentor ceiling" would be a confident answer to a question that tenant
    // never asked; the empty list is what the screen and the Excel export
    // already read as "no capacity section". INTERNSHIP carries the module, so
    // its report is unchanged.
    const capacity = capabilities.includes('mentorship') ? await mentorCapacity() : [];

    return NextResponse.json({
      order,
      conversions,
      biggestDropOff: biggestDropOff(conversions),
      timeToHire: tth,
      capacity,
      cohortConversion,
      retention,
      // Echoed so the screen can say which journeys these numbers describe.
      journeys: journeys.length,
    });
  });
}
