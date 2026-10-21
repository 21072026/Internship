// Employer recruiting analytics (#1911) — the pure half. The route
// (src/app/api/company/analytics/route.ts) reads one company's applications,
// their stage events and its requisition fills for a date window; everything
// that turns those rows into numbers lives here, reusing the admin-side maths
// rather than re-implementing it:
//   • the funnel and time-to-hire are funnelKpi's stageConversions() and
//     timeToHire() over Application journeys (censoring included: a candidate
//     still in the funnel is not a hire at day 0);
//   • time-to-fill is days from a requisition's opening to the seat being taken
//     by an accepted offer (Offer.requisitionCountedAt, #1854) — an unfilled
//     requisition is EXCLUDED, never counted as zero, and the population it
//     was computed over is returned with it;
//   • the benchmark is benchmarkPool's benchmarkFigures() with its two floors.
// No Prisma import, so the page and the unit spec read the same rules.
import { cohortMonths, stageConversions, timeToHire, type Journey, type StageConversion, type TimeToHire } from '@/lib/funnelKpi';
import { periodOf, type Period } from '@/lib/meteringRules';
import { rangeEnd, rangeStart } from '@/lib/dateRange';
import { APPLICATION_SOURCES, type ApplicationSource } from '@/lib/applications';

/** The on-path order of an application — the terminal REJECTED / WITHDRAWN are off-path, so a drop stops where it was. */
export const RECRUITING_ORDER = ['APPLIED', 'SCREENING', 'SHORTLISTED', 'INTERVIEW', 'OFFER', 'HIRED'] as const;

const DAY = 86_400_000;

/**
 * The report window. Default: the start of the month five months back until
 * now (the admin analytics default). A malformed or inverted range falls back
 * to the default instead of failing — the same rule as the admin route.
 */
export function resolveWindow(params: { from: string | null; to: string | null }, now: Date): { from: Date; to: Date } {
  const to = rangeEnd(params.to) ?? now;
  const defaultFrom = new Date(to.getFullYear(), to.getMonth() - 5, 1);
  let from = rangeStart(params.from) ?? defaultFrom;
  if (from.getTime() > to.getTime()) from = defaultFrom;
  return { from, to };
}

export interface ApplicationRow {
  createdAt: Date;
  source: string;
  status: string;
  events: { toStage: string; createdAt: Date }[];
}

/** One application as a funnel journey: it starts where its first event put it, and moves with every later one. */
export function journeyOf(app: ApplicationRow): Journey {
  const events = [...app.events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const [first, ...rest] = events;
  return {
    startStatus: first?.toStage ?? 'APPLIED',
    startedAt: app.createdAt.getTime(),
    changes: rest.map((e) => ({ toStatus: e.toStage, at: e.createdAt.getTime() })),
  };
}

export function recruitingFunnel(apps: readonly ApplicationRow[]): { stages: StageConversion[]; timeToHire: TimeToHire } {
  const order = [...RECRUITING_ORDER];
  const journeys = apps.map(journeyOf);
  return { stages: stageConversions(order, journeys), timeToHire: timeToHire(order, journeys) };
}

export interface FillRow {
  openedAt: Date;
  filledAt: Date;
}

export interface TimeToFill {
  /** Seats filled in the window — the population the numbers describe. */
  filled: number;
  /** Requisitions open at some point in the window, filled or not — the censoring, made visible. */
  considered: number;
  medianDays: number | null;
  avgDays: number | null;
}

export function timeToFill(fills: readonly FillRow[], considered: number): TimeToFill {
  const days = fills.map((f) => (f.filledAt.getTime() - f.openedAt.getTime()) / DAY).filter((d) => d >= 0).sort((a, b) => a - b);
  if (days.length === 0) return { filled: 0, considered, medianDays: null, avgDays: null };
  const mid = Math.floor(days.length / 2);
  const median = days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2;
  return {
    filled: days.length,
    considered,
    medianDays: Math.round(median),
    avgDays: Math.round(days.reduce((s, d) => s + d, 0) / days.length),
  };
}

export interface SourceRow {
  source: ApplicationSource;
  applications: number;
  hired: number;
  /** Hired ÷ applications as a whole percentage; null with no applications (never 0/0). */
  conversion: number | null;
}

/** Where this company's candidates came from — the Application's own source — and how each source converts. */
export function sourceBreakdown(apps: readonly Pick<ApplicationRow, 'source' | 'status'>[]): SourceRow[] {
  return APPLICATION_SOURCES.map((source) => {
    const mine = apps.filter((a) => a.source === source);
    const hired = mine.filter((a) => a.status === 'HIRED').length;
    return { source, applications: mine.length, hired, conversion: mine.length ? Math.round((hired / mine.length) * 100) : null };
  });
}

export interface TrendMonth {
  month: Period;
  applications: number;
  /** Forward moves on the funnel (not into REJECTED / WITHDRAWN, not the creation event, not a hire). */
  advances: number;
  hires: number;
}

/** Monthly applications, advances and hires over the window (UTC months, oldest first, at most 24). */
export function recruitingTrend(
  window: { from: Date; to: Date },
  applicationsCreated: readonly Date[],
  events: readonly { fromStage: string | null; toStage: string; createdAt: Date }[],
): TrendMonth[] {
  const months = cohortMonths(window.from, window.to, 24);
  const rows = new Map<Period, TrendMonth>(months.map((m) => [m, { month: m, applications: 0, advances: 0, hires: 0 }]));
  for (const at of applicationsCreated) {
    const row = rows.get(periodOf(at));
    if (row) row.applications += 1;
  }
  const onPath = new Set<string>(RECRUITING_ORDER);
  for (const e of events) {
    const row = rows.get(periodOf(e.createdAt));
    if (!row || e.fromStage === null) continue;
    if (e.toStage === 'HIRED') row.hires += 1;
    else if (onPath.has(e.toStage)) row.advances += 1;
  }
  return months.map((m) => rows.get(m)!);
}
