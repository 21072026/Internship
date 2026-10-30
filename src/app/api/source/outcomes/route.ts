import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { attributedLeadWhere } from '@/lib/leadAttribution';
import { outcomeStageKeysFrom, resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { DEFAULT_MIN_COHORT } from '@/lib/reports/definitions';
import { flooredRate, referralRow, summarizeOutcomes, type ReferralInput } from '@/lib/sourceOutcomesRule';
import { getLocale } from '@/i18n/server';

// GET /api/source/outcomes?from=&to= — the SOURCE outcome panel (#1914): of the
// candidates THIS referral partner sent, how many were placed, where they stand,
// how long placement took, month by month, plus the per-person rows the panel
// exports. The numbers are src/lib/sourceOutcomesRule.ts's.
//
// SCOPE IS SERVER-SIDE AND FAILS CLOSED. The source is read from the caller's
// own user row (the same `ownSourceId` shape as ../mentees), never from the
// request; a SOURCE login with no source gets 403 — the bug shape
// /api/company/analytics documents, where a missing link fell into the
// unscoped branch. Every query also carries the caller's org by hand.
//
// The one figure that is not about this source — the programme's conversion,
// for comparison — is a single rate over every referral partner of the tenant,
// floored like the source's own (DEFAULT_MIN_COHORT, #1903) and withheld
// entirely while the source's own rate is suppressed.

async function ownSourceId(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { sourceId: true, role: true } });
  return u?.role === 'SOURCE' ? u.sourceId : null;
}

/** The default window: the last twelve calendar months, this one included (UTC). */
function resolveWindow(params: URLSearchParams, now: Date): { from: Date; to: Date } {
  const to = rangeEnd(params.get('to')) ?? now;
  const defaultFrom = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 11, 1));
  let from = rangeStart(params.get('from')) ?? defaultFrom;
  if (from.getTime() > to.getTime()) from = defaultFrom;
  return { from, to };
}

async function referrals(where: Prisma.UserWhereInput) {
  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      fullName: true,
      createdAt: true,
      menteeRelations: {
        select: {
          startDate: true,
          pipelineStatus: true,
          statusChanges: { select: { toStatus: true, createdAt: true } },
        },
      },
    },
  });
  return users.map((u) => ({
    fullName: u.fullName,
    input: {
      id: u.id,
      referredAt: u.createdAt,
      relations: u.menteeRelations.map((r) => ({
        startedAt: r.startDate,
        pipelineStatus: r.pipelineStatus,
        changes: r.statusChanges.map((c) => ({ toStatus: c.toStatus, at: c.createdAt })),
      })),
    } satisfies ReferralInput,
  }));
}

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'SOURCE') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const orgId = resolveOrgId(session);
  const denied = await requireCapability(orgId, 'sourcing');
  if (denied) return denied;

  return await withTenantScope(session, async () => {
    const sourceId = await ownSourceId(session.user.id);
    if (!sourceId) return NextResponse.json({ error: 'No source' }, { status: 403 });

    const now = new Date();
    const { from, to } = resolveWindow(new URL(request.url).searchParams, now);
    const locale = await getLocale();
    const stages = await resolvePipelineStages(orgId, locale);
    const outcome = outcomeStageKeysFrom(stages);

    const inWindow: Prisma.UserWhereInput = { ...attributedLeadWhere(), orgId, createdAt: { gte: from, lte: to } };
    const [own, programme] = await Promise.all([
      referrals({ ...inWindow, sourceId }),
      referrals({ ...inWindow, sourceId: { not: null } }),
    ]);

    const rows = own.map((r) => ({ fullName: r.fullName, ...referralRow(r.input, outcome.finished, now) }));
    const summary = summarizeOutcomes(rows, { offPath: outcome.offPath, minCohort: DEFAULT_MIN_COHORT, from, to });
    const programmeRows = programme.map((r) => referralRow(r.input, outcome.finished, now));
    const programmeRate = summary.suppressed
      ? { rate: null, suppressed: true }
      : flooredRate(programmeRows.filter((r) => r.placed).length, programmeRows.length, DEFAULT_MIN_COHORT);

    const labelOf = (key: string | null) => (key ? stageLabel(stages, key, locale) : null);
    // Stage distribution in the tenant's own order; keys that are not in the
    // resolved set any more (a deleted custom stage) keep their place at the end.
    const order = [...stages].sort((a, b) => a.order - b.order).map((s) => s.key);
    const stageKeys = Object.keys(summary.stages).filter((k) => k !== '');
    stageKeys.sort((a, b) => (order.indexOf(a) === -1 ? 1e6 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 1e6 : order.indexOf(b)));

    return NextResponse.json({
      window: { from: from.toISOString(), to: to.toISOString() },
      minCohort: DEFAULT_MIN_COHORT,
      finishedLabel: outcome.finishedLabel,
      referred: summary.referred,
      inPipeline: summary.inPipeline,
      placed: summary.placed,
      conversion: summary.conversion,
      suppressed: summary.suppressed,
      programmeConversion: programmeRate.rate,
      programmeSuppressed: programmeRate.suppressed,
      notPickedUp: summary.stages[''] ?? 0,
      stages: stageKeys.map((key) => ({ key, label: labelOf(key), count: summary.stages[key] })),
      timeToPlacement: summary.timeToPlacement,
      trend: summary.trend,
      rows: rows.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        referredAt: r.referredAt.toISOString(),
        stage: r.stage,
        stageLabel: labelOf(r.stage),
        daysSinceReferral: r.daysSinceReferral,
        placed: r.placed,
        placedAt: r.placedAt?.toISOString() ?? null,
      })),
    });
  });
}
