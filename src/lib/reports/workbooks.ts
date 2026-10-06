// The export workbooks' ROWS, server-side (#1903 part 2). The analytics and
// candidates screens used to build every sheet in the browser from data they
// already held; they now receive finished sheets from
// GET /api/admin/export/[dataset] and only hand them to src/lib/excel.ts,
// which keeps SheetJS code-split out of the page bundle.
//
// The four sheets that ARE named reports — Funnel, Mentors, Cohorts, Sources —
// come from the report registry, so the workbook and the single-report
// download cannot disagree, and the cohort and source sheets carry the privacy
// floor (a full report is exactly the file that leaves the building). The
// remaining sheets (conversion, time to hire, trials, capacity, trends, drop
// reasons) are screen-specific KPI tables, moved here unchanged.

import type { Dictionary } from '@/i18n/dictionaries';
import type { ScorecardRow, ScorecardUnit } from '@/lib/programScorecard';
import type { SurveyOverviewRow } from '@/lib/surveyOverview';
import { getReportDefinition } from './definitions';
import { loadReport, ReportUnavailable, type ReportContext } from './registry';
import { renderReport, reportSheet, type Cell, type Sheet } from './render';

type StageLabel = (key: string) => string;

/** A named report as a sheet, or null when this org's vertical lacks its module. */
async function registrySheet(name: string, key: string, ctx: ReportContext, t: Dictionary): Promise<Sheet | null> {
  const def = getReportDefinition(key);
  if (!def) throw new Error(`unknown report ${key}`);
  try {
    const loaded = await loadReport(def, ctx);
    return reportSheet(name, renderReport(def, loaded, t.reports), loaded);
  } catch (error) {
    if (error instanceof ReportUnavailable && error.status === 404) return null;
    throw error;
  }
}

// ── Candidates ───────────────────────────────────────────────────────────────

interface CandidateRow {
  fullName: string;
  email: string;
  phone?: string | null;
  whatsapp?: string | null;
  city?: string | null;
  university?: string | null;
  department?: string | null;
  graduationYear?: number | null;
  skills?: string[];
  menteeRelations?: { pipelineStatus?: string; mentor?: { fullName: string } | null; company?: { name: string } | null }[];
}

export function candidatesSheet(candidates: CandidateRow[], stageLabel: StageLabel): Sheet {
  return {
    name: 'Candidates',
    columns: ['Name', 'Email', 'Phone', 'WhatsApp', 'City', 'University', 'Department', 'Graduation', 'Skills', 'Stage', 'Project', 'Mentor'],
    rows: candidates.map((c) => {
      const rel = c.menteeRelations?.[0];
      return [
        c.fullName, c.email, c.phone ?? '', c.whatsapp ?? '', c.city ?? '', c.university ?? '', c.department ?? '',
        c.graduationYear ?? '', (c.skills ?? []).join('; '),
        rel?.pipelineStatus ? stageLabel(rel.pipelineStatus) : '',
        rel?.company?.name ?? '', rel?.mentor?.fullName ?? '',
      ];
    }),
  };
}

// ── Analytics ────────────────────────────────────────────────────────────────

interface FunnelKpi {
  conversions: { key: string; entered: number; advanced: number; rate: number | null; terminal: boolean }[];
  timeToHire: { completed: number; considered: number; medianDays: number | null; avgDays: number | null };
  capacity: { fullName: string; activeMenteeCount: number; mentorCapacity: number | null; capacityKnown: boolean; overloaded: boolean }[];
  trialConversion?: {
    months: { month: string; started: number; paid: number; rate: number | null }[];
    bySource?: { name: string | null; trials: number; paid: number; rate: number | null }[] | null;
  } | null;
}

interface AnalyticsSources {
  analytics: { trends?: { months: string[]; newRelations: number[]; interactions: number[] } | null };
  aging: { dropReasons?: { pipelineStatus: string; reasonCode: string; count: number }[] } | null;
  funnel: FunnelKpi | null;
  /** The programme health scorecard (#1908) — the first sheet when present. */
  scorecard?: ScorecardRow[] | null;
  /** Every survey, floored like the results screen (#1910). */
  surveys?: SurveyOverviewRow[] | null;
}

// The surveys (#1910): counts always, the rate and the NPS only at or above
// each survey's floor — a blank there is "fewer than the floor", said in words.
function surveysSheet(rows: SurveyOverviewRow[] | null | undefined, t: Dictionary): Sheet[] {
  if (!rows || rows.length === 0) return [];
  const s = t.surveyResults;
  const label = (prefix: string, v: string) => (s as Record<string, string>)[`${prefix}_${v}`] ?? v;
  return [
    {
      name: 'Surveys',
      columns: [s.colSurvey, s.colStatus, s.colAnonymity, s.colInvited, s.colResponses, s.colRate, s.colNps, s.colNpsN],
      rows: rows.map((r): Cell[] => [
        r.title,
        label('status', r.status),
        label('anonymity', r.anonymity),
        r.invited,
        r.responses,
        r.rate === null ? s.belowFloor : `${r.rate}%`,
        r.nps === null ? (r.npsN > 0 ? s.belowFloor : '—') : r.nps,
        r.npsN,
      ]),
    },
  ];
}

// The programme health scorecard (#1908) as a sheet, so the verdict reaches
// the sponsor's deck with the numbers: value, the count behind it, the
// target and the band — or why there is no value.
function scorecardSheet(rows: ScorecardRow[] | null | undefined, t: Dictionary): Sheet[] {
  if (!rows || rows.length === 0) return [];
  const s = t.scorecard;
  const fmt = (v: number, unit: ScorecardUnit) => s.units[unit].replace('{v}', String(v));
  const target = (r: { target: number; direction: 'higher' | 'lower'; unit: ScorecardUnit }) =>
    (r.direction === 'higher' ? s.targetAtLeast : s.targetAtMost).replace('{v}', fmt(r.target, r.unit));
  return [
    {
      name: 'Programme health',
      columns: [s.colIndicator, s.colValue, s.colTarget, s.colBand, s.colBasis],
      rows: rows.map((r): Cell[] =>
        r.status === 'ok'
          ? [s.indicators[r.key], fmt(r.value, r.unit), target(r), s.bands[r.band], r.basis]
          : r.status === 'insufficient'
            ? [s.indicators[r.key], s.notEnough, target(r), '', r.basis]
            : [s.indicators[r.key], s.notMeasurable, r.dependsOn.map((n) => s.needs.replace('{n}', String(n))).join(' · '), '', ''],
      ),
    },
  ];
}

// KPI rows shared by both workbooks (#815) — the ratios travel with the counts
// rather than living only on screen.
function kpiSheets(src: FunnelKpi | null, t: Dictionary, stageLabel: StageLabel): Sheet[] {
  if (!src) return [];
  const k = t.analytics.funnelKpi;
  const sheets: Sheet[] = [
    {
      name: 'Conversion',
      columns: [k.stage, k.entered, k.advanced, k.conversion],
      rows: src.conversions.map((c) => [
        stageLabel(c.key),
        c.entered,
        c.advanced,
        c.rate === null ? (c.terminal ? '—' : k.noData) : `${c.rate}%`,
      ]),
    },
  ];
  if (src.timeToHire.completed > 0) {
    sheets.push({
      name: 'Time to hire',
      columns: [k.timeToHireMedian, k.timeToHireAvg, k.entered],
      // The population comes along, so a spreadsheet cannot quote the median
      // without the caveat the screen shows.
      rows: [[
        src.timeToHire.medianDays ?? '—',
        src.timeToHire.avgDays ?? '—',
        `${src.timeToHire.completed}/${src.timeToHire.considered}`,
      ]],
    });
  }
  // Trial → paid (#2556): one row per trial month, and the source split when
  // the tier includes it. An immature month exports "—", not a rate the screen
  // would not show.
  if (src.trialConversion) {
    const tk = t.analytics.trialKpi;
    sheets.push({
      name: 'Trial to paid',
      columns: [tk.month, tk.started, tk.paid, tk.rate],
      rows: src.trialConversion.months.map((m) => [m.month, m.started, m.paid, m.rate === null ? '—' : `${m.rate}%`]),
    });
    if (src.trialConversion.bySource && src.trialConversion.bySource.length > 0) {
      sheets.push({
        name: 'Trial by source',
        columns: [tk.source, tk.started, tk.paid, tk.rate],
        rows: src.trialConversion.bySource.map((s) => [s.name ?? tk.noSource, s.trials, s.paid, s.rate === null ? '—' : `${s.rate}%`]),
      });
    }
  }
  if (src.capacity.length > 0) {
    sheets.push({
      name: 'Capacity',
      columns: [k.mentor, k.activeMentees, k.ceiling, k.overloaded],
      rows: src.capacity.map((m) => [
        m.fullName,
        m.activeMenteeCount,
        m.capacityKnown ? (m.mentorCapacity as number) : k.noCeiling,
        m.overloaded ? '!' : '',
      ]),
    });
  }
  return sheets;
}

function dropReasonSheet(src: AnalyticsSources['aging'], t: Dictionary, stageLabel: StageLabel): Sheet[] {
  const reasons = t.dropoff.reasons as Record<string, string>;
  const rows: Cell[][] = (src?.dropReasons ?? []).map((d) => [stageLabel(d.pipelineStatus), reasons[d.reasonCode] ?? d.reasonCode, d.count]);
  return rows.length > 0 ? [{ name: 'Drop reasons', columns: ['Stage', 'Reason', 'Count'], rows }] : [];
}

/** The basic analytics workbook: funnel, KPI tables, drop reasons. */
export async function analyticsWorkbook(src: AnalyticsSources, ctx: ReportContext, t: Dictionary, stageLabel: StageLabel): Promise<Sheet[]> {
  const funnel = await registrySheet('Funnel', 'pipeline-funnel', ctx, t);
  return [...scorecardSheet(src.scorecard, t), ...surveysSheet(src.surveys, t), ...(funnel ? [funnel] : []), ...kpiSheets(src.funnel, t, stageLabel), ...dropReasonSheet(src.aging, t, stageLabel)];
}

/**
 * The premium full report (#540): the basic workbook plus trends and the
 * mentor, cohort and source reports. A report whose module this vertical
 * lacks (mentors and cohorts need `mentorship`) is left out, as on the screen.
 */
export async function fullAnalyticsWorkbook(src: AnalyticsSources, ctx: ReportContext, t: Dictionary, stageLabel: StageLabel): Promise<Sheet[]> {
  const a = t.analytics;
  const trends = src.analytics.trends;
  const [funnel, mentors, cohorts, sources] = await Promise.all([
    registrySheet('Funnel', 'pipeline-funnel', ctx, t),
    registrySheet('Mentors', 'mentor-workload', ctx, t),
    registrySheet('Cohorts', 'cohort-comparison', ctx, t),
    registrySheet('Sources', 'source-conversion', ctx, t),
  ]);
  return [
    ...scorecardSheet(src.scorecard, t),
    ...surveysSheet(src.surveys, t),
    ...(funnel ? [funnel] : []),
    ...kpiSheets(src.funnel, t, stageLabel),
    ...(trends
      ? [{
          name: 'Trends',
          columns: [a.fullReportMonth, a.trendNewRelations, a.trendInteractions],
          rows: trends.months.map((m, i) => [m, trends.newRelations[i], trends.interactions[i]]),
        }]
      : []),
    ...[mentors, cohorts, sources].filter((s): s is Sheet => s !== null),
    ...dropReasonSheet(src.aging, t, stageLabel),
  ];
}
