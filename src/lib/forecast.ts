// The forecast and capacity panel (#1897): last period's conversion multiplied
// forward, with the multiplication shown.
//
// This is NOT a prediction model, and nothing here may be described as one.
// There is no training, no fitted parameter and no confidence interval: every
// number is a product or a sum of rates and medians the analytics screen
// already reports (stage conversion from `stageConversions()`, time in stage
// from `computeStageAging()`), applied to the records sitting in the pipeline
// today. The band around the central figure is a stated SENSITIVITY — each
// stage's rate moved by one standard error of its own history — not a
// probability statement. Every result carries its inputs so the screen can
// show the working.
//
// Pure and Prisma-free so `scripts/test/forecast.test.mjs` runs it without a
// database.

import { furthestIndex, type Journey, type StageConversion } from './funnelKpi';

/** Below this many journeys through a stage, its rate is not projected from. */
export const MIN_JOURNEYS_PER_STAGE = 10;

const DAY = 24 * 60 * 60 * 1000;

/**
 * Stage conversion over RESOLVED journeys only — the censoring rule of
 * `timeToHire()`, applied per stage.
 *
 * An open journey still sitting in stage k has not decided k yet; counting it
 * as "did not advance" would drag k's rate down by however full the pipeline
 * is today, and multiply that into every projection. So k's denominator holds
 * the journeys that got past k plus the closed ones that stopped at k; an open
 * journey counts only for the stages it has already left.
 */
export function resolvedConversions(order: string[], journeys: { journey: Journey; open: boolean }[]): StageConversion[] {
  const reach = journeys.map((j) => ({ at: furthestIndex(order, j.journey), open: j.open }));
  return order.map((key, i) => {
    const advanced = reach.filter((r) => r.at > i).length;
    const entered = advanced + reach.filter((r) => r.at === i && !r.open).length;
    const terminal = i === order.length - 1;
    return { key, entered, advanced, terminal, rate: entered === 0 || terminal ? null : Math.round((advanced / entered) * 100) };
  });
}

export interface ForecastInput {
  /** The tenant's on-path stage keys, in order. */
  order: string[];
  /** The stage that counts as placed (the #1882 outcome anchor). */
  finishedKey: string;
  /** Records sitting in each stage today. */
  cohortByStage: Record<string, number>;
  /** Historical stage-to-stage conversion over `order` (`resolvedConversions()`). */
  conversions: StageConversion[];
  /** Median days actually spent in each stage (completed visits), or null. */
  medianDwellByStage: Record<string, number | null>;
  /** Days from today to the horizon. */
  horizonDays: number;
  /** Override for tests; defaults to MIN_JOURNEYS_PER_STAGE. */
  minJourneys?: number;
}

export interface ForecastStep {
  key: string;
  entered: number;
  advanced: number;
  /** advanced ÷ entered, or null when nobody entered. */
  rate: number | null;
  /** One standard error of that rate, √(p(1−p)/n). */
  spread: number;
  medianDwellDays: number | null;
}

export interface StageProjection {
  key: string;
  /** Records in this stage today. */
  count: number;
  /** Product of the step rates from here to the finished stage. */
  remainingConversion: number;
  /** Sum of the median dwells from here to the finished stage, or null when one is unknown. */
  dwellToFinishDays: number | null;
  /** Whether that sum fits inside the horizon — only then is the stage counted. */
  fits: boolean;
  expected: number;
  low: number;
  high: number;
}

export interface Placements {
  status: 'ok' | 'insufficient' | 'no_population';
  /** Records in the pipeline before the finished stage today. */
  population: number;
  expected: number;
  low: number;
  high: number;
  byStage: StageProjection[];
  steps: ForecastStep[];
  /** Stages under the floor that the projection would have to multiply through. */
  belowFloor: { key: string; entered: number }[];
  minJourneys: number;
  horizonDays: number;
  finishedKey: string;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** The step data for every stage before the finished one. */
function stepsFor(input: ForecastInput, finishedIndex: number): ForecastStep[] {
  const byKey = new Map(input.conversions.map((c) => [c.key, c]));
  return input.order.slice(0, finishedIndex).map((key) => {
    const c = byKey.get(key);
    const entered = c?.entered ?? 0;
    const advanced = c?.advanced ?? 0;
    const rate = entered > 0 ? advanced / entered : null;
    return {
      key,
      entered,
      advanced,
      rate,
      spread: rate === null ? 0 : Math.sqrt((rate * (1 - rate)) / entered),
      medianDwellDays: input.medianDwellByStage[key] ?? null,
    };
  });
}

/**
 * How many of today's records reach the finished stage by the horizon, at the
 * current conversion rates.
 *
 * For each stage: the records there × the product of the remaining step rates,
 * counted only when the summed median dwell to the finished stage fits inside
 * the horizon. A record's time already spent in its stage is not subtracted, so
 * the dwell test errs towards "not yet". `low`/`high` repeat the same
 * arithmetic with every step rate moved down/up by its own standard error.
 *
 * Refuses (status `insufficient`) when any stage the projection multiplies
 * through has fewer than `minJourneys` journeys: a rate off four data points is
 * worse than no forecast.
 */
export function projectPlacements(input: ForecastInput): Placements {
  const minJourneys = input.minJourneys ?? MIN_JOURNEYS_PER_STAGE;
  const finishedIndex = input.order.indexOf(input.finishedKey);
  const empty: Placements = {
    status: 'no_population',
    population: 0,
    expected: 0,
    low: 0,
    high: 0,
    byStage: [],
    steps: [],
    belowFloor: [],
    minJourneys,
    horizonDays: input.horizonDays,
    finishedKey: input.finishedKey,
  };
  if (finishedIndex <= 0) return empty;

  const steps = stepsFor(input, finishedIndex);
  const populated = steps.map((s, i) => ({ i, count: input.cohortByStage[s.key] ?? 0 })).filter((p) => p.count > 0);
  const population = populated.reduce((sum, p) => sum + p.count, 0);
  if (population === 0) return { ...empty, steps };

  // Every step from the earliest populated stage to the finished one is
  // multiplied through by somebody.
  const firstNeeded = populated[0].i;
  const belowFloor = steps
    .slice(firstNeeded)
    .filter((s) => s.entered < minJourneys)
    .map((s) => ({ key: s.key, entered: s.entered }));
  if (belowFloor.length > 0) {
    return { ...empty, status: 'insufficient', population, steps, belowFloor };
  }

  const product = (from: number, rateOf: (s: ForecastStep) => number) =>
    steps.slice(from).reduce((p, s) => p * rateOf(s), 1);
  const byStage: StageProjection[] = populated.map(({ i, count }) => {
    const remaining = steps.slice(i);
    const dwellKnown = remaining.every((s) => s.medianDwellDays !== null);
    const dwellToFinishDays = dwellKnown ? remaining.reduce((d, s) => d + (s.medianDwellDays as number), 0) : null;
    const fits = dwellToFinishDays !== null && dwellToFinishDays <= input.horizonDays;
    const remainingConversion = product(i, (s) => s.rate ?? 0);
    const scale = fits ? count : 0;
    return {
      key: steps[i].key,
      count,
      remainingConversion,
      dwellToFinishDays,
      fits,
      expected: round1(scale * remainingConversion),
      low: round1(scale * product(i, (s) => clamp01((s.rate ?? 0) - s.spread))),
      high: round1(scale * product(i, (s) => clamp01((s.rate ?? 0) + s.spread))),
    };
  });
  const total = (pick: (p: StageProjection) => number) => round1(byStage.reduce((sum, p) => sum + pick(p), 0));
  return {
    ...empty,
    status: 'ok',
    population,
    expected: total((p) => p.expected),
    low: total((p) => p.low),
    high: total((p) => p.high),
    byStage,
    steps,
  };
}

export interface MentorLoad {
  /** Active mentors. */
  mentors: number;
  /** Mentors who stated a capacity. */
  mentorsWithCapacity: number;
  /** The sum of those stated capacities — mentees the mentors agreed to carry at once. */
  seats: number;
}

export interface StageLoad {
  key: string;
  /** Mentee-days this stage needs inside the horizon. */
  requiredDays: number;
  /** Running total up to and including this stage. */
  cumulativeDays: number;
}

export interface CapacityRequirement {
  status: 'ok' | 'unknown';
  byStage: StageLoad[];
  requiredDays: number;
  /** seats × horizon days. */
  availableDays: number;
  /** The first stage where the running total exceeds what is available, or null. */
  bottleneck: string | null;
  /** Mentors to add so the total fits, at the average stated capacity. */
  additionalMentors: number;
  menteesPerMentor: number | null;
  load: MentorLoad;
  horizonDays: number;
}

/**
 * Mentee-days each stage needs inside the horizon against what the mentors
 * agreed to carry.
 *
 * A record at stage s reaches a later stage k with the product of the step
 * rates between them, arrives after the summed median dwells, and then occupies
 * a mentor seat for k's median dwell or until the horizon, whichever is first.
 * Stage loads are summed in pipeline order; the bottleneck is the first stage
 * at which the running total no longer fits in seats × horizon days.
 *
 * `unknown` when no mentor has stated a capacity: an average of nothing is not
 * a number to plan on.
 */
export function capacityRequirement(placements: Placements, load: MentorLoad): CapacityRequirement {
  const horizonDays = placements.horizonDays;
  const menteesPerMentor = load.mentorsWithCapacity > 0 ? load.seats / load.mentorsWithCapacity : null;
  const base: CapacityRequirement = {
    status: 'unknown',
    byStage: [],
    requiredDays: 0,
    availableDays: load.seats * horizonDays,
    bottleneck: null,
    additionalMentors: 0,
    menteesPerMentor,
    load,
    horizonDays,
  };
  if (menteesPerMentor === null || placements.status !== 'ok') return base;

  const steps = placements.steps;
  const counts = new Map(placements.byStage.map((p) => [p.key, p.count]));
  let running = 0;
  const byStage: StageLoad[] = steps.map((stage, k) => {
    let required = 0;
    for (let s = 0; s <= k; s++) {
      const count = counts.get(steps[s].key) ?? 0;
      if (count === 0) continue;
      const between = steps.slice(s, k);
      if (between.some((b) => b.medianDwellDays === null) || stage.medianDwellDays === null) continue;
      const arrival = between.reduce((d, b) => d + (b.medianDwellDays as number), 0);
      const reach = between.reduce((p, b) => p * (b.rate ?? 0), 1);
      const days = Math.min(stage.medianDwellDays, Math.max(0, horizonDays - arrival));
      required += count * reach * days;
    }
    running += required;
    return { key: stage.key, requiredDays: Math.round(required), cumulativeDays: Math.round(running) };
  });

  const availableDays = load.seats * horizonDays;
  const requiredDays = Math.round(running);
  const bottleneck = byStage.find((s) => s.cumulativeDays > availableDays)?.key ?? null;
  const gap = requiredDays - availableDays;
  return {
    ...base,
    status: 'ok',
    byStage,
    requiredDays,
    availableDays,
    bottleneck,
    additionalMentors: gap > 0 && horizonDays > 0 ? Math.ceil(gap / (menteesPerMentor * horizonDays)) : 0,
  };
}

/** Whole days from `now` to the end of the horizon day (UTC), never negative. */
export function horizonDaysFrom(now: Date, horizon: string): number {
  const end = Date.parse(`${horizon}T23:59:59.999Z`);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - now.getTime()) / DAY));
}
