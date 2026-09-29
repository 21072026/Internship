import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolvePipelineStages, outcomeStageKeysFrom } from '@/lib/pipelineStages';
import { onPathKeys } from '@/lib/pipeline';
import type { Prisma } from '@prisma/client';
import {
  biggestDropOff,
  cohortMonths,
  conversionByEntryMonth,
  DEFAULT_RETENTION_BUCKETS,
  mergeChainJourney,
  relationChains,
  retentionTriangle,
  stageConversions,
  timeToHire,
  trialConversion,
  type Journey,
  type TrialJourney,
} from '@/lib/funnelKpi';
import { sourceIsReferral } from '@/lib/referrer';
import { TRIAL_ACTIVE_STAGE_KEY } from '@/lib/trialReminderRule';
import { getSetting } from '@/lib/settings';
import { getMentorAvailability } from '@/lib/mentorAvailability';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { rangeEnd, rangeStart } from '@/lib/dateRange';

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

const RELATION_SELECT = {
  id: true,
  previousRelationId: true,
  pipelineStatus: true,
  startDate: true,
  trialStartedAt: true,
  trialEndsAt: true,
  mentee: { select: { sourceId: true, role: true } },
  statusChanges: {
    orderBy: { createdAt: 'asc' },
    select: { fromStatus: true, toStatus: true, createdAt: true },
  },
} satisfies Prisma.MentorshipRelationSelect;

type RelationRow = Prisma.MentorshipRelationGetPayload<{ select: typeof RELATION_SELECT }>;

/** One relation's own journey, before its chain is folded. */
function relationJourney(r: RelationRow): Journey {
  return {
    // Where the journey began: the stage the first recorded move came FROM,
    // else — for a relation that never moved — where it sits now.
    startStatus: r.statusChanges[0]?.fromStatus ?? r.pipelineStatus,
    startedAt: r.startDate.getTime(),
    changes: r.statusChanges.map((c) => ({ toStatus: c.toStatus, at: c.createdAt.getTime() })),
  };
}

// A chain is one or two links in practice (one per handover); the cap only
// bounds a pathological history so the report cannot loop on it.
const MAX_CHAIN_ROUNDS = 20;

/**
 * Pull in, in place, every predecessor and successor of the loaded relations,
 * transitively (#2556). Runs inside the caller's tenant scope, like every
 * other query here. Without a range the first query already loaded everything,
 * so both lookups come back empty and this costs one round trip.
 */
async function loadWholeChains(relations: RelationRow[]): Promise<void> {
  const known = new Set(relations.map((r) => r.id));
  let frontier = relations;
  for (let round = 0; round < MAX_CHAIN_ROUNDS && frontier.length > 0; round++) {
    const missingParents = [
      ...new Set(
        frontier.map((r) => r.previousRelationId).filter((id): id is string => !!id && !known.has(id)),
      ),
    ];
    const [parents, children] = await Promise.all([
      missingParents.length > 0
        ? prisma.mentorshipRelation.findMany({ where: { id: { in: missingParents } }, select: RELATION_SELECT })
        : Promise.resolve([] as RelationRow[]),
      prisma.mentorshipRelation.findMany({
        where: { previousRelationId: { in: frontier.map((r) => r.id) } },
        select: RELATION_SELECT,
      }),
    ]);
    frontier = [...parents, ...children].filter((r) => {
      if (known.has(r.id)) return false;
      known.add(r.id);
      return true;
    });
    relations.push(...frontier);
  }
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return await withTenantScope(session, async () => {
    // Optional window. TWO populations come out of it, because the sections of
    // this report key their rows on two different dates and no single filter is
    // right for both:
    //
    //   · stage conversion, time-to-hire and the entry-month cohorts are keyed
    //     by the date a record ENTERED, so their population is "started inside
    //     the window". Filtering those by "finished inside the window" would
    //     silently select for fast journeys — the slow ones simply have not
    //     finished yet — and report a time-to-hire that is too good.
    //   · the retention triangle (#2425) is keyed by the date a record was WON.
    //     A deal that arrived in January and was won in May belongs to May's
    //     cohort, and dropping it because January is outside the window would
    //     bias the table towards short sales cycles in the worst possible
    //     place: the OLDEST row of any window is the only one whose 1- and
    //     3-month buckets have closed, and under a start-date filter it could
    //     only ever hold deals that started and closed in the same month. A
    //     past month's retention would then change when the user switched the
    //     range preset, which a historical number must never do.
    //
    // So: one query, widened to "the window touched this record", and the
    // narrower set taken from it in memory — no second round trip.
    const { searchParams } = new URL(request.url);
    // Whole days (#1501): a funnel that ends "today" includes today.
    const from = rangeStart(searchParams.get('from'));
    const to = rangeEnd(searchParams.get('to'));
    const rangeOk = from && to && from.getTime() <= to.getTime();

    const relations = await prisma.mentorshipRelation.findMany({
      where: rangeOk
        ? {
            // Started in the window, OR started earlier and moved inside it —
            // a win IS a StatusChange, so this is exactly the superset the
            // retention cohorts need and nothing more.
            startDate: { lte: to! },
            OR: [
              { startDate: { gte: from! } },
              { statusChanges: { some: { createdAt: { gte: from!, lte: to! } } } },
            ],
          }
        : {},
      select: RELATION_SELECT,
    });
    // The rest of every transfer chain the window touched (#2556), so a chain
    // is folded whole: a successor opened inside the window must not stand in
    // for a journey whose real start is its predecessor's, and a successor
    // opened after the window must not drop the win it recorded.
    await loadWholeChains(relations);

    const orgId = (session.user as { orgId?: string | null }).orgId ?? null;
    const [stages, capabilities] = await Promise.all([resolvePipelineStages(orgId), shellCapabilities(orgId)]);
    const order = onPathKeys(stages);

    // One journey per transfer CHAIN, not per relation (#2556): a handover
    // opens a successor on the same stage, and counted separately it would be
    // a second entry and a second win in the transfer month. The chain's start
    // is its root's, its changes the union of every link's.
    const chains = relationChains(relations);
    const trialJourneys: TrialJourney[] = chains.map((chain) => {
      const merged = mergeChainJourney(chain.map(relationJourney));
      const root = chain[0];
      // The trial window is carried over verbatim on a transfer (#2551), so
      // the earliest recorded start of any link is the chain's.
      const trialStarts = chain.map((r) => r.trialStartedAt?.getTime()).filter((t): t is number => t != null);
      const trialEnds = chain.map((r) => r.trialEndsAt?.getTime()).filter((t): t is number => t != null);
      return {
        ...merged,
        trialStartedAt: trialStarts.length > 0 ? Math.min(...trialStarts) : null,
        trialEndsAt: trialEnds.length > 0 ? Math.max(...trialEnds) : null,
        // The same lead on every link (a transfer keeps `menteeId`), and only
        // a lead whose `sourceId` IS a referral pointer (src/lib/referrer.ts).
        sourceId: root.mentee && sourceIsReferral(root.mentee.role) ? root.mentee.sourceId : null,
      };
    });
    // Everything the window touched — the population the retention triangle is
    // read over, because a record's cohort there is the month it was WON.
    const activeJourneys: Journey[] = trialJourneys;
    // … of which the ones that also STARTED in it: every entry-keyed number
    // below, unchanged from before the cohorts landed.
    const journeys: Journey[] = rangeOk
      ? activeJourneys.filter((j) => j.startedAt >= from!.getTime())
      : activeJourneys;

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
    // Keys, not labels. `resolvePipelineStages` above was called without a
    // locale, so the labels it carries are English; the screen names a stage
    // through `useStageLabel()`, which has the tenant's own labels in the
    // reader's language (#2268). A server-side consumer that needs the name
    // (an export, say) resolves the stages itself with `await getLocale()` —
    // it does not read one off this payload.
    const retention = {
      wonKeys: outcome.finished,
      buckets: DEFAULT_RETENTION_BUCKETS,
      cohorts: retentionTriangle(order, activeJourneys, months, DEFAULT_RETENTION_BUCKETS, {
        wonKeys: outcome.finished,
        offPath: outcome.offPath,
      }),
    };

    // Trial → paid (#2556) — only for a tenant whose stage set HAS a trial
    // stage, resolved from its own rows (an INTERNSHIP org, or a MARKETING org
    // that deleted the stage, gets null and no card). Paid is the tenant's own
    // won stage, the same `toKey` as the cohort conversion above. Cohorted over
    // the same months, but read over `activeJourneys`: a trial that started in
    // the window may belong to a record that entered the funnel before it.
    const trialKey = stages.find((s) => s.key === TRIAL_ACTIVE_STAGE_KEY)?.key ?? null;
    let trial = null;
    if (trialKey && toKey) {
      const [trialLength, premium] = await Promise.all([
        getSetting('trialLengthDays', orgId),
        getSetting('premiumAnalytics', orgId),
      ]);
      const trialDays = Math.max(1, Number.parseInt(trialLength, 10) || 30);
      const result = trialConversion(order, trialJourneys, trialKey, toKey, months, { trialDays });
      // The per-source split is lead ATTRIBUTION, which stays behind the
      // premium tier whatever the vertical (#2421, decision 2 in
      // /api/admin/analytics/sources). Null = locked, [] = nothing mature yet.
      let bySource: { sourceId: string | null; name: string | null; trials: number; paid: number; rate: number | null }[] | null =
        null;
      if (premium === 'true') {
        const ids = result.bySource.map((r) => r.sourceId).filter((id): id is string => !!id);
        const names = new Map(
          (ids.length > 0
            ? await prisma.source.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
            : []
          ).map((s) => [s.id, s.name]),
        );
        bySource = result.bySource.map((r) => ({ ...r, name: r.sourceId ? names.get(r.sourceId) ?? null : null }));
      }
      trial = { trialKey, paidKey: toKey, trialDays, months: result.months, bySource };
    }

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
      trialConversion: trial,
      // Echoed so the screen can say which journeys these numbers describe.
      // The entry-keyed population: what every number on the card but the
      // retention triangle is computed over.
      journeys: journeys.length,
    });
  });
}
