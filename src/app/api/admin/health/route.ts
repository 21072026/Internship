import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { settingsOrgOf } from '@/lib/settingsOrg';
import { resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { getLocale } from '@/i18n/server';
import { HEALTH_RULES_VERSION, type HealthBand, type HealthReason } from '@/lib/relationHealth';
import { assessRelations, HEALTH_RELATION_SELECT, reminderDaysReader, type HealthRelationRow } from '@/lib/relationHealthLive';
import { crossedIntoRiskSince, healthTrendFrom, utcDay } from '@/lib/relationHealthTrend';
import { compareHealthRows, nextActionFor, type NextAction } from '@/lib/healthNextAction';
import { negativeFeedbackFlags } from '@/lib/insights/feedbackFlags';

// GET /api/admin/health — the org-wide at-risk queue (#1902): every ACTIVE
// relation in the caller's tenant scored NOW with the published rules table,
// worst first, each with its reasons, its 30-day trend from the nightly
// snapshots (#1901) and exactly one next action.
//
// Query: band (HEALTHY|WATCH|AT_RISK), mentorId, cohortId, stage, page,
// pageSize (≤100). The counters honour every filter except `band`, so the chips
// above the list always add up to the pairs a band filter can show.
//
// Only pairs with at least one reason are LISTED — a pair with nothing wrong
// has nothing to do, and is counted in `excluded.quiet` instead. Dormant first
// contacts and non-active relations are not scored at all; both are counted
// for the page's footnote, so a short list never looks like a broken one.

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 500;
const BANDS: readonly HealthBand[] = ['HEALTHY', 'WATCH', 'AT_RISK'];

export async function GET(request: Request) {
  const gate = await requirePermission('analytics.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // The page is closed by gatePage for a vertical without mentorship; the API
  // answers the same (the adminWeeklyReports precedent, #1918).
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;

  const url = new URL(request.url);
  const bandParam = url.searchParams.get('band');
  const band = BANDS.includes(bandParam as HealthBand) ? (bandParam as HealthBand) : null;
  const mentorId = url.searchParams.get('mentorId') || null;
  const cohortId = url.searchParams.get('cohortId') || null;
  const stage = url.searchParams.get('stage') || null;
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('pageSize') || '25', 10) || 25, 1), 100);
  const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
  const locale = await getLocale();
  const settingsOrg = await settingsOrgOf(session);

  return withTenantScope(session, async () => {
    // The tenant is a hand-written conjunct, not left to the middleware: that
    // is a no-op while MT_ENFORCE_ISOLATION is off (#2542).
    const tenant = await tenantWhere(session);
    const narrow: Prisma.MentorshipRelationWhereInput = {
      ...(mentorId ? { mentorId } : {}),
      ...(cohortId ? { cohortId } : {}),
      ...(stage ? { pipelineStatus: stage } : {}),
    };
    const activeWhere = withinTenant({ ...narrow, status: 'ACTIVE' as const }, tenant);

    const now = new Date();
    const reminderDaysFor = reminderDaysReader();
    const scored: { row: HealthRelationRow; score: number | null; band: HealthBand; reasons: HealthReason[]; lastContactAt: Date | null }[] = [];
    let dormant = 0;
    let paused = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await prisma.mentorshipRelation.findMany({
        where: activeWhere,
        select: HEALTH_RELATION_SELECT,
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const a of await assessRelations(rows, now, reminderDaysFor)) {
        if (a.assessment.excluded) {
          // A pause keeps status ACTIVE, so it arrives here too (#1894).
          if (a.assessment.why === 'paused') paused++;
          else dormant++;
          continue;
        }
        scored.push({ row: a.row, score: a.assessment.score, band: a.assessment.band, reasons: a.assessment.reasons, lastContactAt: a.lastContactAt });
      }
    }

    // Negative open-text clusters (#2046): a NOTE beside a pair, read from the
    // newest Insights summaries. It lists a pair that has no other reason, but
    // it never touches the score, the band or anything stored on the relation.
    const feedback = await negativeFeedbackFlags(settingsOrg, now).catch(() => new Map());
    const [notActive, recent] = await Promise.all([
      prisma.mentorshipRelation.count({ where: withinTenant({ ...narrow, status: { not: 'ACTIVE' as const } }, tenant) }),
      // Two weeks of bands: the 7-day window plus the snapshot before it, so a
      // crossing on the window's first day still has a "before".
      prisma.relationHealthSnapshot.findMany({
        where: { relationId: { in: scored.map((s) => s.row.id) }, takenOn: { gte: new Date(utcDay(now).getTime() - 14 * DAY) } },
        select: { relationId: true, takenOn: true, band: true },
      }),
    ]);
    const recentBy = new Map<string, { takenOn: Date; band: string }[]>();
    for (const s of recent) recentBy.set(s.relationId, [...(recentBy.get(s.relationId) ?? []), s]);
    const since = new Date(utcDay(now).getTime() - 6 * DAY);

    const counts = { HEALTHY: 0, WATCH: 0, AT_RISK: 0, crossed7: 0, feedback: 0 };
    for (const s of scored) {
      counts[s.band]++;
      if (feedback.has(s.row.id)) counts.feedback++;
      if (crossedIntoRiskSince(recentBy.get(s.row.id) ?? [], since)) counts.crossed7++;
    }

    const daysSince = (at: Date | null) => (at ? Math.floor((now.getTime() - at.getTime()) / DAY) : null);
    const listed = scored
      .filter((s) => (s.reasons.length > 0 || feedback.has(s.row.id)) && (!band || s.band === band))
      .map((s) => ({ ...s, relationId: s.row.id, daysSinceContact: daysSince(s.lastContactAt) }))
      .sort(compareHealthRows);
    const quiet = scored.filter((s) => s.reasons.length === 0 && !feedback.has(s.row.id) && (!band || s.band === band)).length;
    const pageRows = listed.slice((page - 1) * pageSize, page * pageSize);

    const pageIds = pageRows.map((r) => r.relationId);
    const cohortIds = [...new Set(scored.map((s) => s.row.cohortId).filter((id): id is string => !!id))];
    const [history, cohorts, stages] = await Promise.all([
      prisma.relationHealthSnapshot.findMany({
        where: { relationId: { in: pageIds }, takenOn: { gte: new Date(utcDay(now).getTime() - 31 * DAY) } },
        orderBy: { takenOn: 'asc' },
        select: { relationId: true, takenOn: true, score: true, band: true },
      }),
      prisma.cohort.findMany({ where: { id: { in: cohortIds } }, select: { id: true, name: true } }),
      resolvePipelineStages(settingsOrg, locale),
    ]);
    const historyBy = new Map<string, typeof history>();
    for (const h of history) historyBy.set(h.relationId, [...(historyBy.get(h.relationId) ?? []), h]);
    const cohortName = new Map(cohorts.map((c) => [c.id, c.name]));
    const label = (key: string) => stageLabel(stages, key, locale);

    const rows = pageRows.map((s) => {
      const trend = healthTrendFrom(historyBy.get(s.relationId) ?? [], 30, now);
      const nextAction: NextAction | null = nextActionFor({
        relationId: s.relationId,
        menteeId: s.row.mentee.id,
        mentorId: s.row.mentor.id,
        mentorActive: s.row.mentor.isActive,
        reasons: s.reasons,
        daysSinceContact: s.daysSinceContact,
        ageDays: Math.floor((now.getTime() - s.row.startDate.getTime()) / DAY),
      });
      return {
        relationId: s.relationId,
        score: s.score,
        band: s.band,
        reasons: s.reasons,
        daysSinceLastInteraction: s.daysSinceContact,
        trend7: trend.delta7,
        trend30: trend.delta30,
        series: trend.series,
        mentor: { id: s.row.mentor.id, name: s.row.mentor.fullName },
        mentee: { id: s.row.mentee.id, name: s.row.mentee.fullName },
        stage: { key: s.row.pipelineStatus, label: label(s.row.pipelineStatus) },
        cohort: s.row.cohortId ? { id: s.row.cohortId, name: cohortName.get(s.row.cohortId) ?? '' } : null,
        nextAction,
        feedbackFlag: feedback.get(s.relationId) ?? null,
      };
    });

    // Filter options from the scored set, so a dropdown never offers a choice
    // that empties the list by construction.
    const mentors = new Map<string, string>();
    const stageKeys = new Set<string>();
    for (const s of scored) {
      mentors.set(s.row.mentor.id, s.row.mentor.fullName);
      stageKeys.add(s.row.pipelineStatus);
    }

    return NextResponse.json({
      counts,
      excluded: { dormant, paused, notActive, quiet },
      total: listed.length,
      page,
      pageSize,
      rows,
      filters: {
        mentors: [...mentors].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
        cohorts: cohorts.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)),
        stages: stages.filter((st) => stageKeys.has(st.key)).map((st) => ({ key: st.key, label: label(st.key) })),
      },
      rulesVersion: HEALTH_RULES_VERSION,
    });
  });
}
