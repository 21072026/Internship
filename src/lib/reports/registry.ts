// The report registry's LOADERS (#1903): how each named report in
// definitions.ts is produced, server-side. Every loader is org-scoped and
// returns plain rows — no formatting, no locale words; the route resolves the
// labels and the privacy floor runs on top (privacyFloor.ts).
//
// Where a screen already computes the numbers, the loader calls that screen's
// endpoint in-process instead of re-deriving them: the cohort and source
// reports ARE the cohort-comparison and source-conversion cards, and must not
// drift into a second definition of "converted". Tenant scoping, the
// capability gates and the stage vocabulary (outcomeStageKeys, #1882) come
// with them.

import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import type { Locale } from '@/i18n/config';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { COMPLIANCE_RELATION_SELECT, INTERNED_WHERE, complianceRows } from '@/lib/weeklyReportComplianceQuery';
import { GET as analyticsGET } from '@/app/api/admin/analytics/route';
import { GET as cohortsGET } from '@/app/api/admin/analytics/cohorts/route';
import { GET as sourcesGET } from '@/app/api/admin/analytics/sources/route';
import { DEFAULT_MIN_COHORT, type ReportDefinition } from './definitions';
import { applyMinCohort, type Row } from './privacyFloor';

export interface ReportContext {
  session: Session;
  orgId: string;
  locale: Locale;
  request: Request;
}

/** Hard cap on rows any one report returns — a report is a summary, not a dump. */
const MAX_ROWS = 5000;

async function viaEndpoint(handler: (req: Request) => Promise<Response>, ctx: ReportContext, path: string) {
  const target = new URL(path, new URL(ctx.request.url).origin);
  const res = await handler(new Request(target, { headers: ctx.request.headers }));
  if (!res.ok) throw new ReportUnavailable(res.status);
  return res.json();
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
    const tenant = await tenantWhere(ctx.session);
    const [stages, counts] = await Promise.all([
      resolvePipelineStages(ctx.orgId, ctx.locale),
      prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: withinTenant({}, tenant), _count: { _all: true } }),
    ]);
    const byKey = new Map(counts.map((c) => [c.pipelineStatus, c._count._all]));
    return stages.map((s) => ({ stage: s.label, count: byKey.get(s.key) ?? 0 }));
  },

  async 'cohort-comparison'(ctx) {
    const body = await viaEndpoint(cohortsGET, ctx, '/api/admin/analytics/cohorts');
    return (body.cohorts as { name: string; term: string | null; total: number; inProgress: number; hired: number; dropped: number; conversionToHired: number; avgDaysToHired: number | null }[]).map((c) => ({
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
    const body = await viaEndpoint(sourcesGET, ctx, '/api/admin/analytics/sources');
    return (body.sources as { name: string; mentees: number; inPipeline: number; hired: number }[]).map((s) => ({
      source: s.name,
      total: s.mentees,
      inPipeline: s.inPipeline,
      reachedOutcome: s.hired,
      conversion: pct(s.hired, s.mentees),
    }));
  },

  async 'mentor-workload'(ctx) {
    const body = await viaEndpoint(analyticsGET, ctx, '/api/admin/analytics');
    return (body.mentorWorkload as { fullName: string; active: number; hired: number }[]).map((m) => ({
      mentor: m.fullName,
      active: m.active,
      reachedOutcome: m.hired,
    }));
  },

  async 'placement-outcomes'(ctx) {
    const tenant = await tenantWhere(ctx.session);
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
    const tenant = await tenantWhere(ctx.session);
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
