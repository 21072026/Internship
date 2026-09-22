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

import { isPeriod, periodOf, periodRange, type Period } from './meteringRules';

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

// ── Cohorts (#2420 / #2425) ──────────────────────────────────────────────────
//
// Everything above answers "how does the funnel look right now". These two
// answer "how did the records that entered in a given MONTH do", which is a
// different question and the only one that survives a growing pipeline:
//
//   · A rate computed over "everything that converted this month / everything
//     that entered this month" mixes two populations. A deal signed in March
//     that arrived in January lands in March's numerator and January's
//     denominator, so March can — and in a growing month regularly does —
//     print more than 100%. Cohorting by the month of ENTRY puts both halves
//     of the fraction on the same people (#2420).
//   · "How much of what we won do we keep" cannot be read off the board at
//     all: a customer that left is sitting in a loss stage next to customers
//     that never won anything. It only exists as a per-cohort history, and the
//     young cohorts of that history have not finished happening yet — which is
//     what the maturity rule below is for (#2425).
//
// Month arithmetic is NOT re-implemented here. `periodOf`/`periodRange` are the
// repo's one UTC, half-open month boundary (src/lib/meteringRules.ts, itself
// dependency-free and unit-tested); a second copy is how a cohort month and an
// invoice month end up meaning different things on two screens of the same
// product, and half-open month windows are the classic place to be off by one.

/** A cohort is keyed by its month: 'YYYY-MM', UTC — the same key a billing period uses. */
export type CohortMonth = Period;

const stageIndex = (order: string[]) => new Map(order.map((k, i) => [k, i]));

/**
 * The first moment a journey is known to have been AT OR PAST `atIndex`, or
 * null if it never got that far.
 *
 * Two cases beyond the obvious "it arrived at that stage", and both of them are
 * real data rather than defensive padding:
 *
 *   · It SKIPPED the stage (a rep drags a lead straight from first contact to
 *     proposal). `furthestIndex` already counts that as having passed the
 *     stage, so the cohort must too — the moment it passed is the first arrival
 *     at anything at or beyond it.
 *   · It STARTED at or past the stage — an imported account (#2391 lands live
 *     customers directly on a late stage) or a relation created further along.
 *     It was already past the line when we began watching, so the month we
 *     began watching is its entry month.
 *
 * Keeping both means the cohort denominators add up to exactly the `entered`
 * column of `stageConversions()` for the same stage. Two cards on one screen
 * that disagree about how many records reached a stage is the bug this
 * alignment exists to prevent.
 */
function firstReachedAt(order: string[], journey: Journey, atIndex: number): number | null {
  const index = stageIndex(order);
  if ((index.get(journey.startStatus) ?? -1) >= atIndex) return journey.startedAt;
  for (const c of journey.changes) {
    const i = index.get(c.toStatus);
    if (i !== undefined && i >= atIndex) return c.at;
  }
  return null;
}

export interface EntryMonthConversion {
  month: CohortMonth;
  /** Journeys whose FIRST arrival at `fromKey` fell in this month. */
  entered: number;
  /** ... of which, the ones that reached `toKey` — at any time, however late. */
  converted: number;
  /** Percentage, or null when the month has no denominator (never 0/0). */
  rate: number | null;
}

/**
 * Conversion from one stage to a later one, cohorted by the month of ENTRY.
 *
 * Both keys come from the caller's resolved order — for a marketing tenant
 * typically its qualification stage to its won stage, for the built-in
 * catalogue application to hired. Nothing here knows a stage key.
 *
 * The numerator can never exceed the denominator by construction: both are
 * decided by `furthestIndex`, and `toKey` sits after `fromKey`, so anything
 * that reached `toKey` necessarily reached `fromKey` and was counted in the
 * same month. That is the whole point of #2420 — a month above 100% is not
 * possible rather than merely unlikely.
 *
 * `months` is the list of cohort months to report (oldest first, the shape
 * `trends.months` already uses). A journey whose entry month is outside it is
 * left out rather than folded into an edge bucket, which would overstate that
 * bucket by everything that came before it.
 */
export function conversionByEntryMonth(
  order: string[],
  journeys: Journey[],
  fromKey: string,
  toKey: string,
  months: CohortMonth[],
): EntryMonthConversion[] {
  const index = stageIndex(order);
  const fromIndex = index.get(fromKey);
  const toIndex = index.get(toKey);
  const buckets = new Map(months.map((m) => [m, { entered: 0, converted: 0 }]));

  // Either key missing from this tenant's order, or the pair pointing backwards,
  // means there is no such conversion to state. Empty months with a null rate —
  // the file's convention — rather than a throw or a confident row of zeros.
  if (fromIndex !== undefined && toIndex !== undefined && toIndex > fromIndex) {
    for (const j of journeys) {
      const reach = furthestIndex(order, j);
      if (reach < fromIndex) continue;
      const enteredAt = firstReachedAt(order, j, fromIndex);
      if (enteredAt === null) continue;
      const bucket = buckets.get(periodOf(new Date(enteredAt)));
      if (!bucket) continue;
      bucket.entered++;
      if (reach >= toIndex) bucket.converted++;
    }
  }

  return months.map((month) => {
    const b = buckets.get(month) ?? { entered: 0, converted: 0 };
    return {
      month,
      entered: b.entered,
      converted: b.converted,
      rate: b.entered === 0 ? null : Math.round((b.converted / b.entered) * 100),
    };
  });
}

/** Months after the cohort closed at which retention is read. */
export const DEFAULT_RETENTION_BUCKETS = [1, 3, 6, 12];

export interface RetentionBucket {
  /** Months after the END of the cohort month. */
  months: number;
  /** Cohort members that had reached a loss stage by then — null while the window is still open. */
  churned: number | null;
  /** Percentage of the cohort — null for the same reason, or when the cohort is empty. */
  rate: number | null;
}

export interface RetentionCohort {
  month: CohortMonth;
  /** Journeys that first reached a won stage in this month. */
  won: number;
  buckets: RetentionBucket[];
}

export interface RetentionOptions {
  /** Reference point for "has this window closed yet". */
  now?: Date;
  /**
   * The stage keys that mean "won". Defaults to the last stage of `order`;
   * a caller that has the tenant's resolved outcome set (`outcomeStageKeys`,
   * #1882) should pass it, because for the built-in catalogue the last key
   * alone is EMPLOYED_700 and most records stop at HIRED_660.
   */
  wonKeys?: string[];
  /**
   * The stage keys that mean "lost". Defaults to "anything absent from
   * `order`", which is what off-path means to the rest of this file. Pass the
   * tenant's real off-path keys where they are known, so a stage that was
   * merely REMOVED from the set later is not read as a customer leaving.
   */
  offPath?: string[] | null;
}

/**
 * Retention by won-month: of the records won in a month, how many later left.
 *
 * WHAT CHURN IS HERE, and why there is no CHURNED stage (#2425 asked for the
 * decision to be written down, so it is written down in the code that acts on
 * it): churn is **any arrival at a loss stage after the arrival that won the
 * deal**. It is NOT a new stage in the marketing preset.
 *
 *   · A preset stage would only exist for tenants that took that preset, and
 *     only from the day it was added — every org already provisioned would keep
 *     a stage set with no way to express "this customer left", and their
 *     triangle would read a permanent 0% churn, which is a confident wrong
 *     answer rather than a missing one.
 *   · The loss stage a tenant already has (the marketing preset's "Lost",
 *     off-path and terminal) means "we did not get this deal" BEFORE the win
 *     and "we lost this customer" AFTER it. The same row, read at two points in
 *     its life; the win date is what separates them, and `StatusChange` carries
 *     both dates already. So no model and no stage is added for this.
 *   · It generalises: any tenant, any vertical, any custom stage set marked
 *     off-path gets a triangle without configuring anything.
 *
 * MATURITY. Bucket N is "within N months after the cohort month CLOSED", for
 * every member alike — not N months after each member's own win date. Measuring
 * from the cohort's close is what makes a column comparable down the rows, and
 * it errs in the safe direction: the member won on the 1st gets a slightly
 * longer window than the one won on the 31st, so the number never OVERSTATES
 * retention. A bucket whose window has not closed yet returns null, never 0 —
 * a young cohort has not had time to churn, and printing 0% would advertise
 * perfect retention exactly where there is no evidence at all. The UI renders
 * that null as "—".
 */
export function retentionTriangle(
  order: string[],
  journeys: Journey[],
  months: CohortMonth[],
  buckets: number[] = DEFAULT_RETENTION_BUCKETS,
  options: RetentionOptions = {},
): RetentionCohort[] {
  const now = (options.now ?? new Date()).getTime();
  const onPath = new Set(order);
  const wonKeys = new Set(
    options.wonKeys && options.wonKeys.length > 0 ? options.wonKeys : order.slice(-1),
  );
  // An EMPTY list falls back exactly as an absent one does. A tenant whose
  // stage set marks nothing off-path would otherwise hand in `[]`, which as a
  // Set answers "not a loss" to every key and prints a triangle of confident
  // 0%s — the permanent-0%-churn answer the note above exists to avoid,
  // reached from the other direction. The fallback still has something to say
  // for that org.
  const lossKeys =
    options.offPath && options.offPath.length > 0 ? new Set(options.offPath) : null;
  const isLoss = (key: string) => (lossKeys ? lossKeys.has(key) : !onPath.has(key));

  // month -> { won, churnedAt[] }. One pass over the journeys, then one pass
  // per bucket over the counts, so a wide triangle costs nothing extra.
  const cohorts = new Map(months.map((m) => [m, { won: 0, churnedAt: [] as number[] }]));

  for (const j of journeys) {
    // The winning arrival. A journey that STARTED won (an imported customer)
    // is won as of the moment we began watching it — the same reading
    // `firstReachedAt` gives entry above.
    let wonAt: number | null = null;
    let from = 0;
    if (wonKeys.has(j.startStatus)) {
      wonAt = j.startedAt;
    } else {
      const i = j.changes.findIndex((c) => wonKeys.has(c.toStatus));
      if (i >= 0) {
        wonAt = j.changes[i].at;
        // Scan for the loss from the position AFTER the win, not from a
        // timestamp comparison: two changes can share a millisecond, and the
        // recorded order is the truth about which came first.
        from = i + 1;
      }
    }
    if (wonAt === null) continue;
    const cohort = cohorts.get(periodOf(new Date(wonAt)));
    if (!cohort) continue;
    cohort.won++;
    // The FIRST loss after the win. A record that left, came back and left
    // again left once, on the first date.
    const lost = j.changes.slice(from).find((c) => isLoss(c.toStatus));
    if (lost) cohort.churnedAt.push(lost.at);
  }

  return months.map((month) => {
    const cohort = cohorts.get(month) ?? { won: 0, churnedAt: [] };
    // The cohort month is closed at the start of the next one; a bucket's
    // window ends `n` whole months after that. Always the 1st of a month, so
    // there is no end-of-month clamping to get wrong.
    const closed = periodRange(month).lt;
    return {
      month,
      won: cohort.won,
      buckets: buckets.map((n) => {
        const windowEnd = Date.UTC(closed.getUTCFullYear(), closed.getUTCMonth() + n, 1);
        if (now < windowEnd) return { months: n, churned: null, rate: null };
        const churned = cohort.churnedAt.filter((at) => at < windowEnd).length;
        return {
          months: n,
          churned,
          rate: cohort.won === 0 ? null : Math.round((churned / cohort.won) * 100),
        };
      }),
    };
  });
}

/**
 * The cohort months a window covers, oldest first — the `months` argument both
 * functions above take, built from the date range the screen already asks for.
 *
 * Capped at the most recent 36. The widest preset the analytics screen offers
 * is twelve months; the cap only stops a hand-typed `?from=1970-01-01` from
 * asking for six hundred columns, and it keeps the newest ones because those
 * are the rows anyone is reading.
 *
 * This is also the choke point for what a month key may LOOK like. A year
 * outside 1000-9999 — `?from=0999-01-01`, which `new Date()` parses happily —
 * formats as `999-01`, which `periodRange()` rejects with a throw; a range no
 * screen can produce would then 500 the endpoint instead of rendering an empty
 * card. Anything the period grammar does not accept is dropped here, so every
 * consumer below can take a `CohortMonth` at its word.
 */
export function cohortMonths(from: Date, to: Date, max = 36): CohortMonth[] {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return [];
  const out: CohortMonth[] = [];
  let cursor = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1);
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1);
  while (cursor <= last) {
    const d = new Date(cursor);
    out.push(periodOf(d));
    cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out.filter((m) => isPeriod(m)).slice(-max);
}
