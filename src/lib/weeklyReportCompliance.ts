// Weekly-report compliance — the one place that decides what "compliant" means
// (#1917, story #1916). The admin listing, the per-intern detail, the coming
// compliance screen (#1918), its export and any future chase-up all read their
// numbers from here, so "missing" or "late" can never mean two things.
//
// PURE ON PURPOSE: no Prisma, no Next. The caller loads the rows (one query per
// kind for a whole page of relations — see src/app/api/admin/weekly-reports)
// and this module only does arithmetic, which is what lets
// scripts/test/weekly-report-compliance.test.mjs pin the edges down.
//
// THE DEFINITIONS
//
//   Internship window — the period a mentee owes weekly reports for: from the
//     moment the relation entered the internship stage to the moment it left
//     it. `internshipWindow()` is the ONE lookup for it, so when #1622 promotes
//     Cohort to a Program with real term dates, the term boundary becomes a
//     change to that function and nothing else. (A Cohort has no dates today —
//     only a free-text `term` — so the relation's own stage history is the
//     only honest source.)
//
//   Expected week — a UTC week (Monday 00:00Z, `utcWeekStart`, the same grain
//     as WeeklyReport's @@unique([relationId, weekStart]) and the mentee's own
//     submission) that lies wholly inside the window and has already ENDED. A
//     week the internship starts in mid-week is not owed — the same
//     `firstFullUtcWeek` rule the attention queue applies — and neither is the
//     week it ends in mid-week, nor the week that is still running.
//
//   Submitted — the week has a report in a submitted state (SUBMITTED,
//     APPROVED, CHANGES_REQUESTED). A DRAFT is not a report anyone can sign,
//     so a week with only a draft is MISSING.
//
//   Reviewed — the mentor has acted on it (APPROVED or CHANGES_REQUESTED).
//
//   Late — first submitted after the week it COVERS had ended. Never measured
//     against today: a report filed on Sunday night for that same week is on
//     time no matter when anyone looks. A report with no recorded submission
//     time (rows from before `submittedAt` existed) is not called late — the
//     honest answer there is "unknown", and unknown must not count against an
//     intern.
//
//   Rate — submitted ÷ expected, and `null` when nothing is expected yet. An
//     intern whose first full week has not ended owes nothing; showing them at
//     0% would sort them to the top of the worst-offenders list.

import { addUtcWeeks, firstFullUtcWeek, utcWeekEnd } from './week';

/** The stage a mentee writes weekly reports in (reminders and the attention queue use the same key). */
export const INTERNSHIP_STAGE_KEY = 'INTERNSHIP_IN_PROGRESS_450';

/** Statuses that count as "handed in". Mirrors SUBMITTED_WEEKLY_REPORT_STATUSES in lib/weeklyReports.ts. */
const SUBMITTED = new Set(['SUBMITTED', 'APPROVED', 'CHANGES_REQUESTED']);
const REVIEWED = new Set(['APPROVED', 'CHANGES_REQUESTED']);

export interface StageMove {
  fromStatus: string;
  toStatus: string;
  createdAt: Date;
}

export interface WindowSource {
  pipelineStatus: string;
  startDate: Date;
  completedAt: Date | null;
  /** The relation's stage moves; any order. Only moves into or out of the internship stage matter. */
  changes: StageMove[];
}

export interface InternshipWindow {
  start: Date;
  /** null = the internship is still running. */
  end: Date | null;
}

/**
 * When did this relation's internship run? `null` when it never did — or when
 * nothing on record says when it started, which is the same thing for the
 * purposes of counting weeks.
 *
 *   start — the FIRST move into the internship stage. A relation that sits in
 *           the stage with no such move (an import, a stage set at creation)
 *           falls back to its own startDate — the rule the attention queue and
 *           the Friday reminder already use for it.
 *   end   — the first move OUT of the stage after that start; for a relation
 *           still in it, its completedAt if it was completed there; otherwise
 *           open.
 *
 * A relation that left the stage and came back (dropped, then re-admitted) is
 * read as ONE window, first entry to last exit (or still open). That counts
 * the gap as owed weeks; it is the simple, visible choice until there is a
 * real re-admission flow, and an admin reading the detail sees exactly which
 * weeks it claims.
 */
export function internshipWindow(source: WindowSource): InternshipWindow | null {
  const moves = [...source.changes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const entry = moves.find((m) => m.toStatus === INTERNSHIP_STAGE_KEY && m.fromStatus !== INTERNSHIP_STAGE_KEY);
  const inStageNow = source.pipelineStatus === INTERNSHIP_STAGE_KEY;
  const start = entry ? entry.createdAt : inStageNow ? source.startDate : null;
  if (!start) return null;
  if (inStageNow) return { start, end: source.completedAt };
  const exits = moves.filter((m) => m.fromStatus === INTERNSHIP_STAGE_KEY && m.toStatus !== INTERNSHIP_STAGE_KEY && m.createdAt >= start);
  const lastExit = exits.at(-1);
  return { start, end: lastExit ? lastExit.createdAt : source.completedAt };
}

/**
 * The UTC week starts a mentee owes a report for, oldest first.
 * `range` narrows the answer to a reporting period (the listing's from/to):
 * weeks that START before `from` or END after `to` are left out.
 */
export function expectedWeeks(
  window: InternshipWindow | null,
  now: Date,
  range: { from?: Date | null; to?: Date | null } = {}
): Date[] {
  if (!window) return [];
  const limit = Math.min(now.getTime(), window.end ? window.end.getTime() : Infinity, range.to ? range.to.getTime() : Infinity);
  const weeks: Date[] = [];
  // 520 weeks = ten years: a guard against a corrupt start date, not a rule.
  for (let week = firstFullUtcWeek(window.start), i = 0; i < 520; week = addUtcWeeks(week, 1), i++) {
    if (utcWeekEnd(week).getTime() >= limit) break;
    if (range.from && week.getTime() < range.from.getTime()) continue;
    weeks.push(week);
  }
  return weeks;
}

export interface ReportRow {
  weekStart: Date;
  status: string;
  submittedAt: Date | null;
}

export interface Compliance {
  expected: number;
  submitted: number;
  reviewed: number;
  /** Expected weeks with no submitted report, oldest first. */
  missing: Date[];
  /** Submitted weeks whose first submission came after the week ended, oldest first. */
  late: Date[];
  /** submitted / expected, rounded to 3 places; null when nothing is expected yet. */
  rate: number | null;
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 1000);

/**
 * One relation's numbers. Only reports for EXPECTED weeks count — the week
 * still running, or one outside the window, can neither raise the rate above
 * 100% nor mark anything late.
 */
export function complianceForRelation({ expected, reports }: { expected: Date[]; reports: ReportRow[] }): Compliance {
  const byWeek = new Map(reports.map((r) => [r.weekStart.getTime(), r]));
  let submitted = 0;
  let reviewed = 0;
  const missing: Date[] = [];
  const late: Date[] = [];
  for (const week of expected) {
    const report = byWeek.get(week.getTime());
    if (!report || !SUBMITTED.has(report.status)) {
      missing.push(week);
      continue;
    }
    submitted++;
    if (REVIEWED.has(report.status)) reviewed++;
    if (report.submittedAt && report.submittedAt.getTime() > utcWeekEnd(week).getTime()) late.push(week);
  }
  return { expected: expected.length, submitted, reviewed, missing, late, rate: ratio(submitted, expected.length) };
}

export interface RollUp {
  relations: number;
  /** Relations that owe at least one week — the denominator a "how many are behind" reading wants. */
  reporting: number;
  /** Relations with at least one missing week. */
  behind: number;
  expected: number;
  submitted: number;
  reviewed: number;
  missing: number;
  late: number;
  rate: number | null;
}

/** Programme-level totals over any number of relations. */
export function rollUp(rows: Compliance[]): RollUp {
  const total = rows.reduce(
    (acc, r) => ({
      reporting: acc.reporting + (r.expected > 0 ? 1 : 0),
      behind: acc.behind + (r.missing.length > 0 ? 1 : 0),
      expected: acc.expected + r.expected,
      submitted: acc.submitted + r.submitted,
      reviewed: acc.reviewed + r.reviewed,
      missing: acc.missing + r.missing.length,
      late: acc.late + r.late.length,
    }),
    { reporting: 0, behind: 0, expected: 0, submitted: 0, reviewed: 0, missing: 0, late: 0 }
  );
  return { relations: rows.length, ...total, rate: ratio(total.submitted, total.expected) };
}

/** One row per expected week, for the per-intern detail. */
export type WeekState = 'missing' | 'draft' | 'submitted' | 'approved' | 'changes_requested';

export interface WeekDetail<R extends ReportRow = ReportRow> {
  weekStart: Date;
  state: WeekState;
  late: boolean;
  report: R | null;
}

export function weekByWeek<R extends ReportRow>(expected: Date[], reports: R[]): WeekDetail<R>[] {
  const byWeek = new Map(reports.map((r) => [r.weekStart.getTime(), r]));
  return expected.map((weekStart) => {
    const report = byWeek.get(weekStart.getTime()) ?? null;
    const state: WeekState = !report
      ? 'missing'
      : report.status === 'DRAFT'
        ? 'draft'
        : (report.status.toLowerCase() as WeekState);
    const late = !!report && SUBMITTED.has(report.status) && !!report.submittedAt && report.submittedAt.getTime() > utcWeekEnd(weekStart).getTime();
    return { weekStart, state, late, report };
  });
}
