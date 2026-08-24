// Hiring-funnel KPIs (#815): stage-to-stage conversion and time-to-hire, both
// derived from the same StatusChange audit trail the aging report already uses.
// Pure and client-safe — the API computes with these and the UI renders the
// result, so there is one definition of each number.
//
// Two traps this file exists to avoid, because both silently produce a WRONG
// number rather than an obviously broken one:
//
//   1. Stage order is not fixed. Since #747 stages are org-configurable
//      strings, so the caller passes the tenant's own on-path order and no key
//      like 'HIRED_660' is assumed to exist.
//   2. Time-to-hire is right-censored. Candidates still moving through the
//      pipeline have no end date; averaging only those who finished, without
//      saying so, reports a number that describes a population nobody asked
//      about. So the result carries the population it was computed over, and
//      the UI states it.

export interface Journey {
  /** The stage the relation started in. */
  startStatus: string;
  /** When the journey began (ms since epoch). */
  startedAt: number;
  /** Stage arrivals in chronological order. */
  changes: { toStatus: string; at: number }[];
}

export interface StageConversion {
  key: string;
  /** Journeys that got at least this far. */
  entered: number;
  /** ... and then got further. */
  advanced: number;
  /**
   * Percentage that moved on, or null when there is no rate to state: nobody
   * reached the stage (never 0/0), or it is the last stage and there is nowhere
   * further to go.
   */
  rate: number | null;
  /** The end of the order — reaching it is finishing, not failing to advance. */
  terminal: boolean;
}

/**
 * How far along the on-path order a journey got.
 *
 * The FURTHEST stage reached, not the number of stages visited: real pipelines
 * skip stages (an admin moves someone straight from application to interview),
 * and a journey that skipped a stage still progressed past it. Counting it in
 * neither the numerator nor the denominator of that stage would understate
 * progression at exactly the point HR is looking at.
 *
 * Off-path stages are absent from `order`, so a dropped candidate simply stops
 * at the last on-path stage they reached — which is the right answer.
 */
export function furthestIndex(order: string[], journey: Journey): number {
  const index = new Map(order.map((k, i) => [k, i]));
  let best = index.get(journey.startStatus) ?? -1;
  for (const c of journey.changes) {
    const i = index.get(c.toStatus);
    if (i !== undefined && i > best) best = i;
  }
  return best;
}

/** Conversion from each stage to anywhere further along the org's own order. */
export function stageConversions(order: string[], journeys: Journey[]): StageConversion[] {
  const reach = journeys.map((j) => furthestIndex(order, j));
  return order.map((key, i) => {
    const entered = reach.filter((r) => r >= i).length;
    const advanced = reach.filter((r) => r > i).length;
    const terminal = i === order.length - 1;
    return {
      key,
      entered,
      advanced,
      terminal,
      // No entries means no rate — reporting 0% would claim everyone dropped
      // out of a stage nobody was ever in. The last stage has no rate either:
      // "0% advanced" from the end of the funnel describes people who FINISHED,
      // and rendering that as a conversion failure is exactly the misreading
      // this KPI exists to prevent.
      rate: entered === 0 || terminal ? null : Math.round((advanced / entered) * 100),
    };
  });
}

export interface TimeToHire {
  /** The stage key that counts as "finished" — the org's last on-path stage. */
  completionKey: string | null;
  /** Journeys that reached it. This is the population the numbers describe. */
  completed: number;
  /** Journeys considered in total, finished or not — the censoring, made visible. */
  considered: number;
  medianDays: number | null;
  avgDays: number | null;
}

/**
 * Days from the start of a journey to the first arrival at the org's final
 * on-path stage.
 *
 * ONLY COMPLETED JOURNEYS COUNT, deliberately. A candidate still in the
 * pipeline has no end date; the alternatives are to drop them (this), to treat
 * "today" as their end (which invents an ending and drags the average down as
 * the pipeline fills), or to fit a survival estimator (real, but a much larger
 * claim than this data supports). The population is returned alongside the
 * numbers so the screen can say which one it is.
 */
export function timeToHire(order: string[], journeys: Journey[]): TimeToHire {
  const completionKey = order.length > 0 ? order[order.length - 1] : null;
  if (!completionKey) {
    return { completionKey: null, completed: 0, considered: journeys.length, medianDays: null, avgDays: null };
  }
  const DAY = 24 * 60 * 60 * 1000;
  const durations: number[] = [];
  for (const j of journeys) {
    // First arrival, not the last: a re-entry to the final stage is not a
    // second hire.
    const arrival = j.changes.find((c) => c.toStatus === completionKey);
    if (!arrival) continue;
    const days = (arrival.at - j.startedAt) / DAY;
    if (days >= 0) durations.push(days);
  }
  if (durations.length === 0) {
    return { completionKey, completed: 0, considered: journeys.length, medianDays: null, avgDays: null };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    completionKey,
    completed: durations.length,
    considered: journeys.length,
    medianDays: Math.round(median),
    avgDays: Math.round(durations.reduce((s, d) => s + d, 0) / durations.length),
  };
}

/**
 * The stage where the funnel loses the most people — where to look first.
 *
 * The terminal stage is excluded: everyone sitting there completed the journey,
 * and since it is usually the fullest end state it would otherwise win this
 * comparison every time and point HR at the one place nothing is wrong.
 */
export function biggestDropOff(conversions: StageConversion[]): StageConversion | null {
  const candidates = conversions.filter((c) => !c.terminal && c.entered > 0 && c.advanced < c.entered);
  if (candidates.length === 0) return null;
  return candidates.reduce((worst, c) => (c.entered - c.advanced > worst.entered - worst.advanced ? c : worst));
}
