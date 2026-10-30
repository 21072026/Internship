// The SOURCE outcome panel's arithmetic (#1914): what the candidates one
// referral partner sent us actually became. Pure and dependency-free — the API
// (src/app/api/source/outcomes/route.ts) reads the rows, this file decides every
// number, and scripts/test/source-outcomes.test.mjs pins it.
//
// Three rules, each of which would otherwise produce a plausible WRONG number:
//
//   1. "Placed" is the tenant's own finished stage set (`outcomeStageKeys()`,
//      #1882), never a literal 'HIRED_660'. The caller passes the keys.
//   2. Time-to-placement is right-censored: a referral that has not been placed
//      has no end date. It is LEFT OUT of the median — counting it as zero, or
//      as "today minus referral date", both lie. `considered` carries the
//      population so the screen can say what the median describes.
//   3. A rate over a handful of people is somebody's outcome, not a rate. Below
//      `minCohort` (the report registry's floor, #1903 — DEFAULT_MIN_COHORT) the
//      conversion and the programme comparison are null + `suppressed`, never a
//      percentage. The COUNTS stay: they are the institution's own referrals.
//
// Placements are NOT broken down by company: no rule in this codebase says a
// company agreed to be named to a third party, and this panel is not the place
// to invent one (#1914). The panel says "N placed".

export interface ReferralInput {
  id: string;
  /** When the source referred the person — the mentee row's creation. */
  referredAt: Date;
  /** The person's relations, in any order. */
  relations: {
    /** When the relation began (`startDate`). */
    startedAt: Date;
    pipelineStatus: string;
    /** Stage arrivals on this relation, any order. */
    changes: { toStatus: string; at: Date }[];
  }[];
}

export interface ReferralRow {
  id: string;
  referredAt: Date;
  /** The stage of the newest relation, or null while nobody has picked the person up. */
  stage: string | null;
  placed: boolean;
  /** First arrival at a finished stage, null when not placed. */
  placedAt: Date | null;
  /** Whole days from referral to `asOf`. */
  daysSinceReferral: number;
}

export interface OutcomeSummary {
  referred: number;
  /** Picked up (has a relation) and neither placed nor off-path. */
  inPipeline: number;
  placed: number;
  /** Percent placed, or null when `suppressed` / nobody was referred. */
  conversion: number | null;
  suppressed: boolean;
  /** Referrals per current stage key ('' = not picked up yet), counts only. */
  stages: Record<string, number>;
  timeToPlacement: { medianDays: number | null; placed: number; considered: number };
  /** One point per UTC month of the window, oldest first. */
  trend: { month: string; referred: number; placed: number }[];
}

const DAY = 24 * 60 * 60 * 1000;

/** One referral, reduced to what the panel and the export show. */
export function referralRow(input: ReferralInput, finished: readonly string[], asOf: Date): ReferralRow {
  const done = new Set(finished);
  const newest = [...input.relations].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  let placedAt: Date | null = null;
  for (const r of input.relations) {
    const arrivals = r.changes.filter((c) => done.has(c.toStatus)).map((c) => c.at);
    // A relation created straight onto a finished stage has no change row for
    // it; its start is the arrival.
    if (arrivals.length === 0 && done.has(r.pipelineStatus)) arrivals.push(r.startedAt);
    for (const at of arrivals) if (!placedAt || at < placedAt) placedAt = at;
  }
  return {
    id: input.id,
    referredAt: input.referredAt,
    stage: newest?.pipelineStatus ?? null,
    placed: placedAt !== null,
    placedAt,
    daysSinceReferral: Math.max(0, Math.floor((asOf.getTime() - input.referredAt.getTime()) / DAY)),
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** 'YYYY-MM' (UTC) for every month from `from` to `to`, inclusive. */
export function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth();
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
    if (out.length > 240) break;
  }
  return out;
}

const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/** A percentage, or null below the floor — the one place the floor is applied. */
export function flooredRate(part: number, whole: number, minCohort: number): { rate: number | null; suppressed: boolean } {
  if (whole < minCohort) return { rate: null, suppressed: true };
  return { rate: Math.round((part / whole) * 100), suppressed: false };
}

export function summarizeOutcomes(
  rows: readonly ReferralRow[],
  opts: { offPath: readonly string[]; minCohort: number; from: Date; to: Date },
): OutcomeSummary {
  const off = new Set(opts.offPath);
  const placed = rows.filter((r) => r.placed);
  const inPipeline = rows.filter((r) => !r.placed && r.stage !== null && !off.has(r.stage)).length;
  const stages: Record<string, number> = {};
  for (const r of rows) stages[r.stage ?? ''] = (stages[r.stage ?? ''] ?? 0) + 1;
  const { rate, suppressed } = flooredRate(placed.length, rows.length, opts.minCohort);
  const durations = placed
    .map((r) => (r.placedAt!.getTime() - r.referredAt.getTime()) / DAY)
    .filter((d) => d >= 0);
  const trend = monthsBetween(opts.from, opts.to).map((month) => ({
    month,
    referred: rows.filter((r) => monthOf(r.referredAt) === month).length,
    // Placements are dated by the placement, so a referral from January placed
    // in March counts in March — the month the institution would report it.
    placed: placed.filter((r) => monthOf(r.placedAt!) === month).length,
  }));
  return {
    referred: rows.length,
    inPipeline,
    placed: placed.length,
    conversion: rate,
    suppressed,
    stages,
    timeToPlacement: { medianDays: median(durations), placed: durations.length, considered: rows.length },
    trend,
  };
}
