import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { entitled } from '@/lib/entitlements';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { withTenantScope } from '@/lib/orgContext';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { getLocale } from '@/i18n/server';
import { onPathKeys, outcomeStageKeysFrom, resolvePipelineStages } from '@/lib/pipelineStages';
import { cutChurnLinks, mergeChainJourney, relationChains, type Journey } from '@/lib/funnelKpi';
import { computeStageAging } from '@/lib/stageAging';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { capacityRequirement, horizonDaysFrom, projectPlacements, resolvedConversions } from '@/lib/forecast';

// GET /api/admin/analytics/forecast?horizon=YYYY-MM-DD — the forecast and
// capacity panel of the executive dashboard (#1897).
//
// At the current conversion rate, not a prediction: the step rates are
// `resolvedConversions()` over the journeys that started in the last year, the
// dwell is the median time actually spent per stage over visits that ended in
// that year (`computeStageAging()`), and the population is every ACTIVE record
// on the pipeline today. The arithmetic is src/lib/forecast.ts and comes back
// with its inputs.
//
// Premium: ADVANCED_ANALYTICS, checked here — hiding the panel is not access
// control. `horizon` defaults to six months from today and is clamped to
// between tomorrow and two years out.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 365;
const MAX_HORIZON_DAYS = 731;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const RELATION_SELECT = {
  id: true,
  previousRelationId: true,
  lifecycleState: true,
  status: true,
  pipelineStatus: true,
  startDate: true,
  menteeId: true,
  statusChanges: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, createdAt: true } },
} satisfies Prisma.MentorshipRelationSelect;

type RelationRow = Prisma.MentorshipRelationGetPayload<{ select: typeof RELATION_SELECT }>;

/** One relation's own journey — the same reading as the funnel route's. */
function relationJourney(r: RelationRow): Journey {
  return {
    startStatus: r.statusChanges[0]?.fromStatus ?? r.pipelineStatus,
    startedAt: r.startDate.getTime(),
    changes: r.statusChanges.map((c) => ({ toStatus: c.toStatus, at: c.createdAt.getTime() })),
  };
}

function horizonOf(raw: string | null, now: Date): string {
  const fallback = new Date(now);
  fallback.setUTCMonth(fallback.getUTCMonth() + 6);
  const min = isoDay(new Date(now.getTime() + DAY));
  const max = isoDay(new Date(now.getTime() + MAX_HORIZON_DAYS * DAY));
  const day = raw && DATE_RE.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? raw : isoDay(fallback);
  return day < min ? min : day > max ? max : day;
}

export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const settingsOrg = await settingsOrgOf(session);
  if (!(await entitled(settingsOrg, 'ADVANCED_ANALYTICS'))) {
    return NextResponse.json({ error: 'feature_locked', code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' }, { status: 403 });
  }

  const now = new Date();
  const horizon = horizonOf(new URL(request.url).searchParams.get('horizon'), now);
  const historyFrom = now.getTime() - HISTORY_DAYS * DAY;
  const locale = await getLocale();

  return withTenantScope(session, async () => {
    // The tenant is a hand-written conjunct (#2542).
    const tenant = await tenantWhere(session);
    const [relations, stages, capabilities] = await Promise.all([
      prisma.mentorshipRelation.findMany({ where: withinTenant({}, tenant), select: RELATION_SELECT }),
      resolvePipelineStages(settingsOrg, locale),
      shellCapabilities(settingsOrg),
    ]);
    const order = onPathKeys(stages);
    const outcome = outcomeStageKeysFrom(stages);
    const finishedKey = outcome.finished[0] ?? '';

    // History: one journey per transfer chain (#2556), started in the last
    // year. A chain whose last link is still ACTIVE is open, and only counts
    // for the stages it has already left (resolvedConversions).
    const journeys = relationChains(cutChurnLinks(relations))
      .map((chain) => ({ journey: mergeChainJourney(chain.map(relationJourney)), open: chain.some((r) => r.status === 'ACTIVE') }))
      .filter((j) => j.journey.startedAt >= historyFrom);
    const conversions = resolvedConversions(order, journeys);
    const aging = computeStageAging(
      relations.map((r) => ({ menteeId: r.menteeId, startDate: r.startDate, statusChanges: r.statusChanges })),
      (leftAt) => leftAt >= historyFrom,
    ).rows;
    const medianDwellByStage = Object.fromEntries(order.map((k) => [k, aging.find((a) => a.pipelineStatus === k)?.medianDays ?? null]));

    // Today's population: what sits on each on-path stage now.
    const cohortByStage: Record<string, number> = {};
    for (const r of relations) {
      if (r.status !== 'ACTIVE') continue;
      cohortByStage[r.pipelineStatus] = (cohortByStage[r.pipelineStatus] ?? 0) + 1;
    }

    const placements = projectPlacements({
      order,
      finishedKey,
      cohortByStage,
      conversions,
      medianDwellByStage,
      horizonDays: horizonDaysFrom(now, horizon),
    });

    // Mentor seats only exist where the vertical carries mentors (#2423).
    let capacity = null;
    if (capabilities.includes('mentorship')) {
      const mentors = await prisma.user.findMany({
        where: withinTenant({ role: { in: ['MENTOR' as const, 'ADMIN' as const] }, isActive: true }, tenant),
        select: { mentorCapacity: true },
      });
      const stated = mentors.filter((m) => m.mentorCapacity != null && m.mentorCapacity > 0);
      capacity = capacityRequirement(placements, {
        mentors: mentors.length,
        mentorsWithCapacity: stated.length,
        seats: stated.reduce((sum, m) => sum + (m.mentorCapacity as number), 0),
      });
    }

    return NextResponse.json({
      horizon,
      historyDays: HISTORY_DAYS,
      // Labels in the reader's language, the tenant's own names first (#2268).
      stages: stages.map((s) => ({ key: s.key, label: s.label })),
      finishedKey,
      finishedLabel: outcome.finishedLabel,
      placements,
      capacity,
    });
  });
}
