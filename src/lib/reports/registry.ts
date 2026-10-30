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
import type { Prisma } from '@prisma/client';
import { attributeLabel } from '@/lib/orgAttributesRule';
import { attributedLeadWhere } from '@/lib/leadAttribution';
import { DEFAULT_MIN_COHORT, type ReportDefinition, type SegmentSubject } from './definitions';
import { applyMinCohort, type Row } from './privacyFloor';
import { SEGMENT_BELOW, SEGMENT_NONE, SEGMENT_OTHER, pickSegment, planSegments, type PlanInput, type PlannedSegment } from './segmentRule';

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
  /**
   * Slice by an org-defined attribute (#1920): `by` is the attribute's key;
   * with `value` only that segment is loaded, without it one block of rows per
   * segment (the groupBy variant). An unknown or non-segmentable key — an
   * attribute deleted since a subscription stored it — degrades to the
   * unsliced report, never to an error.
   */
  segment?: { by: string; value?: string | null } | null;
}

/** What a loader receives: the context plus, when sliced, the subject-person filter. */
interface LoaderContext extends ReportContext {
  person?: Prisma.UserWhereInput;
}

/** Hard cap on rows any one report returns — a report is a summary, not a dump. */
const MAX_ROWS = 5000;

async function scopeOf(ctx: LoaderContext): Promise<AnalyticsScope> {
  return {
    stageOrgId: ctx.stageOrgId === undefined ? ctx.orgId : ctx.stageOrgId,
    tenant: await orgWhere(ctx.orgId),
    locale: ctx.locale,
    ...(ctx.person ? { person: ctx.person } : {}),
  };
}

/** A relation filter for a sliced loader: its mentee is in the segment. */
const menteeIn = (ctx: LoaderContext): Prisma.MentorshipRelationWhereInput => (ctx.person ? { mentee: { is: ctx.person } } : {});

/** A report the caller cannot have (capability, entitlement) — the route answers with this status. */
export class ReportUnavailable extends Error {
  constructor(public status: number) {
    super(`report unavailable (${status})`);
  }
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);

const LOADERS: Record<string, (ctx: LoaderContext) => Promise<Row[]>> = {
  async 'pipeline-funnel'(ctx) {
    const { tenant, stageOrgId } = await scopeOf(ctx);
    const [stages, counts] = await Promise.all([
      resolvePipelineStages(stageOrgId, ctx.locale),
      prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: withinTenant(menteeIn(ctx), tenant), _count: { _all: true } }),
    ]);
    const byKey = new Map(counts.map((c) => [c.pipelineStatus, c._count._all]));
    return stages.map((s) => ({ stage: s.label, count: byKey.get(s.key) ?? 0 }));
  },

  async 'pipeline-summary'(ctx) {
    const { tenant, stageOrgId } = await scopeOf(ctx);
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [stages, counts, newRelations, interactions] = await Promise.all([
      resolvePipelineStages(stageOrgId, ctx.locale),
      prisma.mentorshipRelation.groupBy({ by: ['pipelineStatus'], where: withinTenant(menteeIn(ctx), tenant), _count: { _all: true } }),
      prisma.mentorshipRelation.count({ where: withinTenant({ startDate: { gte: weekAgo }, ...menteeIn(ctx) }, tenant) }),
      prisma.interactionLog.count({
        where: { date: { gte: weekAgo }, ...interactionInTenant(tenant), ...(ctx.person ? { AND: [{ relation: { is: menteeIn(ctx) } }] } : {}) },
      }),
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
      // A reversed placement (#1765) is a hire that was undone.
      where: withinTenant({ reversedAt: null, ...(ctx.person ? { mentee: { is: ctx.person } } : {}) }, tenant),
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
      where: withinTenant(ctx.person ? { AND: [INTERNED_WHERE, menteeIn(ctx)] } : INTERNED_WHERE, tenant),
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

export interface LoadedSegment {
  /** The attribute's key and its label in the reader's language. */
  by: string;
  label: string;
  /** Filter mode: the requested value; null in the groupBy variant. */
  value: string | null;
  /** Filter mode: the requested segment is under the floor, so nothing is shown. */
  suppressed: boolean;
  /** Segments folded into the below-threshold bucket (groupBy variant). */
  suppressedSegments: number;
}

export interface LoadedReport {
  rows: Row[];
  /** Groups merged into the privacy-floor bucket (aggregate reports only; summed over segments). */
  suppressedGroups: number;
  minCohort: number | null;
  /** Set when the report was sliced; every row then carries a `segment` cell (groupBy variant). */
  segment?: LoadedSegment | null;
  /** Why a requested slice was not applied (`unknown_attribute` | `not_segmentable`). */
  segmentIgnored?: string | null;
}

/** The smallest group (and segment) this report may show on its own. */
function floorOf(def: ReportDefinition): number {
  return Math.max(def.minCohort ?? DEFAULT_MIN_COHORT, DEFAULT_MIN_COHORT);
}

async function loadRows(def: ReportDefinition, ctx: LoaderContext): Promise<{ rows: Row[]; suppressedGroups: number }> {
  const loader = LOADERS[def.key];
  if (!loader) throw new ReportUnavailable(404);
  const rows = (await loader(ctx)).slice(0, MAX_ROWS);
  if (!def.aggregate) return { rows, suppressedGroups: 0 };
  const floored = applyMinCohort(rows, { columns: def.columns, sizeColumn: def.sizeColumn!, labelColumn: def.labelColumn!, minCohort: floorOf(def) });
  return { rows: floored.rows, suppressedGroups: floored.suppressedGroups };
}

/** The people a report is about — who a segment's size is counted over. */
function subjectWhere(subject: SegmentSubject): Prisma.UserWhereInput {
  return subject === 'mentor' ? { role: 'MENTOR' } : attributedLeadWhere();
}

/** A planned segment as a filter on the subject person (a relation subquery, never an id list). */
function segmentWhere(attributeId: string, seg: PlannedSegment): Prisma.UserWhereInput {
  const parts: Prisma.UserWhereInput[] = [];
  if (seg.values.length > 0) parts.push({ attributeValues: { some: { attributeId, value: { in: seg.values } } } });
  if (seg.includesNone) parts.push({ attributeValues: { none: { attributeId } } });
  return parts.length === 1 ? parts[0] : { OR: parts };
}

function segmentName(key: string, type: string, ctx: ReportContext, minCohort: number): string {
  const R = getDictionary(ctx.locale).reports.segment;
  if (key === SEGMENT_NONE) return R.none;
  if (key === SEGMENT_OTHER) return R.other;
  if (key === SEGMENT_BELOW) return R.below.replace('{n}', String(minCohort));
  if (type === 'DATE') return (R.tenure as Record<string, string>)[key] ?? key;
  return key;
}

/**
 * Load one report for the caller: capability check, loader, then the privacy
 * floor — and, when sliced, the segment plan first. Query count of a sliced
 * report: 3 to plan (the attribute, one grouped value count, one "no value"
 * count) + the loader's own queries once per shown segment; at most
 * MAX_SEGMENTS + 3 segments (the cap, "other values", "no value" and the
 * below-threshold bucket), so the count is bounded whatever the org's size.
 */
export async function loadReport(def: ReportDefinition, ctx: ReportContext): Promise<LoadedReport> {
  if (def.capability && !(await shellCapabilities(ctx.orgId)).includes(def.capability)) throw new ReportUnavailable(404);
  if (!LOADERS[def.key]) throw new ReportUnavailable(404);
  const minCohort = def.aggregate ? floorOf(def) : null;

  if (ctx.segment?.by) {
    const sliced = await loadSegmented(def, ctx, ctx.segment);
    if (sliced) return sliced;
    // Degraded: the attribute is gone or not segmentable — the unsliced report.
    const plain = await loadRows(def, ctx);
    const attr = await prisma.orgAttribute.findFirst({ where: { orgId: ctx.orgId, key: ctx.segment.by }, select: { id: true } });
    return { ...plain, minCohort, segment: null, segmentIgnored: attr ? 'not_segmentable' : 'unknown_attribute' };
  }
  const { rows, suppressedGroups } = await loadRows(def, ctx);
  return { rows, suppressedGroups, minCohort };
}

async function loadSegmented(def: ReportDefinition, ctx: ReportContext, request: { by: string; value?: string | null }): Promise<LoadedReport | null> {
  if (!def.segmentSubject) return null;
  const attr = await prisma.orgAttribute.findFirst({
    where: { orgId: ctx.orgId, key: request.by, isSegmentable: true },
    select: { id: true, key: true, labelEn: true, labelTr: true, labelDe: true, type: true, options: true },
  });
  if (!attr) return null;
  const segmentFloor = floorOf(def);
  const tenant = await orgWhere(ctx.orgId);
  const subject = subjectWhere(def.segmentSubject);
  const [counts, noneCount] = await Promise.all([
    prisma.userAttributeValue.groupBy({ by: ['value'], where: { orgId: ctx.orgId, attributeId: attr.id, user: { is: withinTenant(subject, tenant) } }, _count: { _all: true } }),
    prisma.user.count({ where: withinTenant({ AND: [subject, { attributeValues: { none: { attributeId: attr.id } } }] }, tenant) }),
  ]);
  const input: PlanInput = {
    type: attr.type,
    options: attr.options,
    counts: counts.map((c) => ({ value: c.value, count: c._count._all })),
    noneCount,
    minCohort: segmentFloor,
    now: new Date(),
  };
  const base = { by: attr.key, label: attributeLabel(attr, ctx.locale) };
  const minCohort = def.aggregate ? segmentFloor : null;

  if (request.value) {
    const { segment, suppressed } = pickSegment(input, request.value);
    if (!segment) {
      return { rows: [], suppressedGroups: 0, minCohort: segmentFloor, segment: { ...base, value: request.value, suppressed, suppressedSegments: 1 } };
    }
    const loaded = await loadRows(def, { ...ctx, person: segmentWhere(attr.id, segment) });
    return { ...loaded, minCohort, segment: { ...base, value: request.value, suppressed: false, suppressedSegments: 0 } };
  }

  const plan = planSegments(input);
  const rows: Row[] = [];
  let suppressedGroups = 0;
  for (const seg of plan.segments) {
    const loaded = await loadRows(def, { ...ctx, person: segmentWhere(attr.id, seg) });
    suppressedGroups += loaded.suppressedGroups;
    const name = segmentName(seg.key, attr.type, ctx, segmentFloor);
    for (const r of loaded.rows) rows.push({ segment: name, ...r });
    if (rows.length >= MAX_ROWS) break;
  }
  return {
    rows: rows.slice(0, MAX_ROWS),
    suppressedGroups,
    // A sliced report always names its floor: the segment split applies it even to a row-level report.
    minCohort: segmentFloor,
    segment: { ...base, value: null, suppressed: false, suppressedSegments: plan.suppressedSegments },
  };
}

/** The keys with a loader — asserted against definitions.ts by the route's sanity check. */
export const LOADED_REPORT_KEYS = Object.keys(LOADERS);
