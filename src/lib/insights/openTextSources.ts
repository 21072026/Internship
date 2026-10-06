// What the open-text insights (#2046) read, server-only: the rows behind a
// summary, the names to mask before any of it leaves, and — for each row — what
// the admin needs to click through to it. Kept apart from the routes so the
// evaluation and weekly-report consumers share one shape.
//
// TENANT: every query is narrowed by hand (`tenantWhere`), the pattern of
// docs/tenant-isolation.md while MT_ENFORCE_ISOLATION is off. Evaluation has no
// orgId of its own; its tenant is its relation's, so only relation-backed rows
// (mentor INTERIM/FINAL evaluations) are read — an interview scorecard has no
// relation and belongs to a candidate process this summary is not about.

import type { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { complianceRows, COMPLIANCE_RELATION_SELECT, INTERNED_WHERE } from '@/lib/weeklyReportComplianceQuery';
import { INTERNSHIP_STAGE_KEY } from '@/lib/weeklyReportCompliance';
import { utcWeekStart } from '@/lib/week';
import type { OpenTextItem } from '@/lib/ai/openTextRules';
import type { OPEN_TEXT_TASKS } from '@/lib/ai/artifacts';

export const INSIGHT_KINDS = ['evaluations', 'weekly-reports'] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

/** The artefact task / gate scope each kind runs as (erasure wipes these, see OPEN_TEXT_TASKS). */
export const INSIGHT_SCOPE: Record<InsightKind, (typeof OPEN_TEXT_TASKS)[number]> = {
  evaluations: 'evaluation_insights',
  'weekly-reports': 'weekly_report_digest',
};

/** What the prompt is told the rows are. */
export const INSIGHT_PURPOSE: Record<InsightKind, string> = {
  evaluations: 'comments mentors wrote in their evaluations of the interns they mentor',
  'weekly-reports': 'blockers interns reported in their weekly reports',
};

/**
 * Named rows still need a few to be worth a theme: two comments are read, not
 * summarised. Anonymous survey answers use the survey's own k-floor instead.
 */
export const NAMED_ROWS_FLOOR = 3;

/** Newest rows read per summary — a bound on the query, not on the prompt (that is the char cap). */
const MAX_ROWS = 400;

export interface InsightFilters {
  from: Date;
  to: Date;
  cohortId?: string | null;
}

export interface SourceRow {
  id: string;
  text: string;
  date: string;
  menteeId: string;
  menteeName: string;
  mentorName: string;
}

export interface InsightSources {
  items: OpenTextItem[];
  sources: Map<string, SourceRow>;
  names: string[];
}

function relationFilter(filters: InsightFilters): Prisma.MentorshipRelationWhereInput {
  return filters.cohortId ? { cohortId: filters.cohortId } : {};
}

export async function loadInsightSources(session: Session, kind: InsightKind, filters: InsightFilters): Promise<InsightSources> {
  const tenant = await tenantWhere(session);
  const relation = withinTenant(relationFilter(filters), tenant);
  const names = new Set<string>();
  const sources = new Map<string, SourceRow>();
  const relSelect = { mentee: { select: { id: true, fullName: true } }, mentor: { select: { fullName: true } } } as const;

  if (kind === 'evaluations') {
    const rows = await prisma.evaluation.findMany({
      where: { relation, comment: { not: null }, createdAt: { gte: filters.from, lte: filters.to } },
      select: { id: true, comment: true, createdAt: true, authorId: true, relation: { select: relSelect } },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    });
    const authors = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.authorId))] } }, select: { fullName: true } });
    for (const a of authors) names.add(a.fullName);
    for (const r of rows) {
      if (!r.relation || !r.comment?.trim()) continue;
      names.add(r.relation.mentee.fullName).add(r.relation.mentor.fullName);
      sources.set(r.id, { id: r.id, text: r.comment, date: r.createdAt.toISOString(), menteeId: r.relation.mentee.id, menteeName: r.relation.mentee.fullName, mentorName: r.relation.mentor.fullName });
    }
  } else {
    const rows = await prisma.weeklyReport.findMany({
      where: withinTenant(
        { relation: relationFilter(filters), status: { not: 'DRAFT' }, blockers: { not: null }, weekStart: { gte: utcWeekStart(filters.from), lte: filters.to } } as Prisma.WeeklyReportWhereInput,
        tenant,
      ),
      select: { id: true, blockers: true, weekStart: true, relation: { select: relSelect } },
      orderBy: { weekStart: 'desc' },
      take: MAX_ROWS,
    });
    for (const r of rows) {
      if (!r.blockers?.trim()) continue;
      names.add(r.relation.mentee.fullName).add(r.relation.mentor.fullName);
      sources.set(r.id, { id: r.id, text: r.blockers, date: r.weekStart.toISOString(), menteeId: r.relation.mentee.id, menteeName: r.relation.mentee.fullName, mentorName: r.relation.mentor.fullName });
    }
  }
  return { items: [...sources.values()].map((s) => ({ id: s.id, text: s.text })), sources, names: [...names] };
}

export interface WeekFigure {
  weekStart: string;
  submitted: number;
  withBlockers: number;
}

export interface WeeklyDigestFigures {
  weeks: WeekFigure[];
  /** The last COMPLETED week, and the interns who owed it and did not hand it in. */
  lastWeekStart: string;
  notSubmitted: { relationId: string; menteeId: string; menteeName: string; mentorName: string }[];
}

/**
 * The digest's numbers — never AI, always rendered. "Not submitted" is the
 * compliance rule's own verdict (src/lib/weeklyReportCompliance.ts) for the
 * last completed week, so this list and /admin/weekly-reports cannot disagree.
 */
export async function weeklyDigestFigures(session: Session, filters: InsightFilters, now = new Date()): Promise<WeeklyDigestFigures> {
  const tenant = await tenantWhere(session);
  const reports = await prisma.weeklyReport.findMany({
    where: withinTenant(
      { relation: relationFilter(filters), status: { not: 'DRAFT' }, weekStart: { gte: utcWeekStart(filters.from), lte: filters.to } } as Prisma.WeeklyReportWhereInput,
      tenant,
    ),
    select: { weekStart: true, blockers: true },
  });
  const byWeek = new Map<number, WeekFigure>();
  for (const r of reports) {
    const key = r.weekStart.getTime();
    const f = byWeek.get(key) ?? { weekStart: r.weekStart.toISOString(), submitted: 0, withBlockers: 0 };
    f.submitted++;
    if (r.blockers?.trim()) f.withBlockers++;
    byWeek.set(key, f);
  }
  const weeks = [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const lastWeek = new Date(utcWeekStart(now).getTime() - 7 * 24 * 60 * 60 * 1000);
  const relations = await prisma.mentorshipRelation.findMany({
    where: withinTenant({ AND: [INTERNED_WHERE, { status: 'ACTIVE', pipelineStatus: INTERNSHIP_STAGE_KEY }, relationFilter(filters)] } as Prisma.MentorshipRelationWhereInput, tenant),
    select: COMPLIANCE_RELATION_SELECT,
    orderBy: [{ mentee: { fullName: 'asc' } }, { id: 'asc' }],
    take: 500,
  });
  const rows = await complianceRows(relations, now);
  const notSubmitted = rows
    .filter((r) => r.compliance.missing.some((w) => w.getTime() === lastWeek.getTime()))
    .slice(0, 50)
    .map((r) => ({ relationId: r.relation.id, menteeId: r.relation.mentee.id, menteeName: r.relation.mentee.fullName, mentorName: r.relation.mentor.fullName }));
  return { weeks, lastWeekStart: lastWeek.toISOString(), notSubmitted };
}
