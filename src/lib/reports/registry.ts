// The report registry's LOADERS (#1903): how each named report in
// definitions.ts is produced, server-side. Every loader is org-scoped and
// returns plain rows — no formatting, no locale words; the route resolves the
// labels and the privacy floor runs on top (privacyFloor.ts).
//
// Where a screen already computes the numbers, the loader calls the SAME
// function the screen's route does (src/lib/analyticsReports.ts) instead of
// re-deriving them: the cohort and source reports ARE the cohort-comparison and
// source-conversion cards, and must not drift into a second definition of
// "converted". Loaders take an org, never a session (#1905): the scheduled
// report subscriptions run with no request at all.

import { prisma } from '@/lib/prisma';
import type { Locale } from '@/i18n/config';
import { outcomeStageKeysFrom, resolvePipelineStages, stageLabel } from '@/lib/pipelineStages';
import { interactionInTenant } from '@/lib/analyticsScope';
import { getDictionary } from '@/i18n/dictionaries';
import { orgWhere, withinTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { COMPLIANCE_RELATION_SELECT, INTERNED_WHERE, complianceRows } from '@/lib/weeklyReportComplianceQuery';
import { cohortComparison, mentorWorkload, sourceConversion, type AnalyticsScope } from '@/lib/analyticsReports';
import { slaCompliance } from '@/lib/slaQueue';
import { DEFAULT_MIN_COHORT, type ReportDefinition } from './definitions';
import { applyMinCohort, type Row } from './privacyFloor';

export interface ReportContext {
  /** The org the report is about — its rows, its capabilities. */
  orgId: string;
  locale: Locale;
  /**
   * The org whose stage set names the stages, when it differs from `orgId`:
   * an org-less admin's screens read the built-in catalogue (null), and a
   * report they download must say what their screen says. Defaults to `orgId`.
   */
  stageOrgId?: string | null;
}

/** Hard cap on rows any one report returns — a report is a summary, not a dump. */
const MAX_ROWS = 5000;

async function scopeOf(ctx: ReportContext): Promise<AnalyticsScope> {
  return { stageOrgId: ctx.stageOrgId === undefined ? ctx.orgId : ctx.stageOrgId, tenant: await orgWhere(ctx.orgId), locale: ctx.locale };
}

/** A report the caller cannot have (capability, entitlement) — the route answers with this status. */
export class ReportUnavailable extends Error {
  constructor(public status: number) {
    super(`report unavailable (${status})`);
  }
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);

const LOADERS: Record<string, (ctx: ReportContext) => Promise<Row[]>> = {
  async 'pipeline-funnel'(ctx) {
    const { tenant, stageOrgId } = await scopeOf(ctx);
    const [stages, counts] = await Promise.all([
      resolvePipelineStages(stageOrgId, ctx.locale),
      prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: withinTenant({}, tenant), _count: { _all: true } }),
    ]);
    const byKey = new Map(counts.map((c) => [c.pipelineStatus, c._count._all]));
    return stages.map((s) => ({ stage: s.label, count: byKey.get(s.key) ?? 0 }));
  },

  async 'pipeline-summary'(ctx) {
    const { tenant, stageOrgId } = await scopeOf(ctx);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [stages, counts, newRelations, interactions] = await Promise.all([
      resolvePipelineStages(stageOrgId, ctx.locale),
      prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: withinTenant({}, tenant), _count: { _all: true } }),
      prisma.mentorshipRelation.count({ where: withinTenant({ startDate: { gte: weekAgo } }, tenant) }),
      prisma.interactionLog.count({ where: { date: { gte: weekAgo }, ...interactionInTenant(tenant) } }),
    ]);
    // "Reached the final stage" is the tenant's own finished set (#1882).
    const { finished } = outcomeStageKeysFrom(stages);
    const total = counts.reduce((n, c) => n + c._count._all, 0);
    const reached = counts.filter((c) => finished.includes(c.pipelineStatus)).reduce((n, c) => n + c._count._all, 0);
    const M = getDictionary(ctx.locale).reports.metric;
    const sla = await slaCompliance(stageOrgId, tenant, 7);
    const slaRows = sla.total > 0
      ? [
          { metric: M.slaMoves7, value: sla.total, share: null },
          { metric: M.slaMet7, value: sla.met, share: sla.rate },
        ]
      : [];
    // Stage rows busiest first, named by the tenant's own labels in the
    // reader's language — never a key.
    const stageRows = counts
      .slice()
      .sort((a, b) => b._count._all - a._count._all)
      .map((c) => ({ metric: M.stage.replace('{stage}', stageLabel(stages, c.pipelineStatus, ctx.locale)), value: c._count._all, share: pct(c._count._all, total) }));
    return [
      { metric: M.total, value: total, share: null },
      { metric: M.reached, value: reached, share: pct(reached, total) },
      { metric: M.new7, value: newRelations, share: null },
      { metric: M.interactions7, value: interactions, share: null },
      // Stage-SLA compliance (#1723): numerator and denominator, the share on
      // the "met" row — the same computation /admin/sla shows. Only when the
      // org has service levels: a pair of zeros would read as a failure.
      ...slaRows,
      ...stageRows,
    ];
  },

  async 'cohort-comparison'(ctx) {
    const { rows } = await cohortComparison(await scopeOf(ctx));
    return rows.map((c) => ({
      cohort: c.term ? `${c.name} (${c.term})` : c.name,
      total: c.total,
      inProgress: c.inProgress,
      reachedOutcome: c.hired,
      dropped: c.dropped,
      conversion: c.total ? c.conversionToHired : null,
      avgDaysToOutcome: c.avgDaysToHired,
    }));
  },

  async 'source-conversion'(ctx) {
    const { rows } = await sourceConversion(await scopeOf(ctx));
    return rows.map((s) => ({
      source: s.name,
      total: s.mentees,
      inPipeline: s.inPipeline,
      reachedOutcome: s.hired,
      conversion: pct(s.hired, s.mentees),
    }));
  },

  async 'mentor-workload'(ctx) {
    return (await mentorWorkload(await scopeOf(ctx))).map((m) => ({
      mentor: m.fullName,
      active: m.active,
      reachedOutcome: m.hired,
    }));
  },

  async 'placement-outcomes'(ctx) {
    const { tenant } = await scopeOf(ctx);
    const groups = await prisma.placement.groupBy({
      by: ['companyId'],
      where: withinTenant({}, tenant),
      _count: { _all: true, valueMinor: true },
    });
    const ids = groups.map((g) => g.companyId).filter((id): id is string => !!id);
    const names = new Map(
      (ids.length ? await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name])
    );
    return groups
      .map((g) => ({ company: (g.companyId && names.get(g.companyId)) || '—', placements: g._count._all, valued: g._count.valueMinor }))
      .sort((a, b) => b.placements - a.placements);
  },

  async 'weekly-report-compliance'(ctx) {
    const { tenant } = await scopeOf(ctx);
    const relations = await prisma.mentorshipRelation.findMany({
      where: withinTenant(INTERNED_WHERE, tenant),
      select: COMPLIANCE_RELATION_SELECT,
      orderBy: [{ mentee: { fullName: 'asc' } }, { id: 'asc' }],
      take: MAX_ROWS,
    });
    return (await complianceRows(relations, new Date())).map(({ relation, compliance }) => ({
      intern: relation.mentee.fullName,
      mentor: relation.mentor.fullName,
      company: relation.company?.name ?? '',
      expected: compliance.expected,
      submitted: compliance.submitted,
      missing: compliance.missing.length,
      late: compliance.late.length,
      rate: compliance.rate === null ? null : Math.round(compliance.rate * 100),
    }));
  },
};

export interface LoadedReport {
  rows: Row[];
  /** Groups merged into the privacy-floor bucket (aggregate reports only). */
  suppressedGroups: number;
  minCohort: number | null;
}

/** Load one report for the caller: capability check, loader, then the privacy floor. */
export async function loadReport(def: ReportDefinition, ctx: ReportContext): Promise<LoadedReport> {
  if (def.capability && !(await shellCapabilities(ctx.orgId)).includes(def.capability)) throw new ReportUnavailable(404);
  const loader = LOADERS[def.key];
  if (!loader) throw new ReportUnavailable(404);
  const rows = (await loader(ctx)).slice(0, MAX_ROWS);
  if (!def.aggregate) return { rows, suppressedGroups: 0, minCohort: null };
  const minCohort = Math.max(def.minCohort ?? DEFAULT_MIN_COHORT, DEFAULT_MIN_COHORT);
  const floored = applyMinCohort(rows, { columns: def.columns, sizeColumn: def.sizeColumn!, labelColumn: def.labelColumn!, minCohort });
  return { rows: floored.rows, suppressedGroups: floored.suppressedGroups, minCohort };
}

/** The keys with a loader — asserted against definitions.ts by the route's sanity check. */
export const LOADED_REPORT_KEYS = Object.keys(LOADERS);
