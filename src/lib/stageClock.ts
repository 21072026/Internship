// The stage clock (#1724): how long a relation has been sitting in the pipeline
// stage it is in now, and whether that is worth somebody's attention.
//
// This module is the single source of truth for that number. The formula used
// to be written out twice — in the admin aging report
// (api/admin/analytics/aging) and in the mentor analytics route — and the two
// copies already disagreed: one clamped a negative duration to zero, the other
// returned it. A third copy on the board would have made "days in stage" mean
// something slightly different on every screen that shows it.
//
// Client-safe on purpose: the mentor board and the mentee portal both classify
// the clock in the browser, so nothing here may import Prisma.

import { defaultPipelineStages, type ResolvedStage } from './pipeline';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A relation as far as the clock is concerned: when it started, and its moves. */
export interface StageClockSource {
  startDate: Date | string;
  /**
   * The relation's recorded stage moves. Order-insensitive — the newest
   * `createdAt` wins — so a caller may hand these over ascending (the aging
   * report reads them that way), descending, or as the single newest row.
   */
  statusChanges?: ReadonlyArray<{ createdAt: Date | string }> | null;
}

const asTime = (value: Date | string): number =>
  (typeof value === 'string' ? new Date(value) : value).getTime();

/**
 * The instant the relation entered its current stage: the last recorded move,
 * else the moment the relation started.
 *
 * Taking the *maximum* of the two rather than "last move, else start" is
 * deliberate. A relation whose startDate was backdated after a move already
 * existed would otherwise report a move that happened before the relation
 * began, i.e. a negative dwell — which is how the two previous copies of this
 * formula came to disagree.
 */
export function stageEnteredAt(relation: StageClockSource): number {
  let entered = asTime(relation.startDate);
  for (const change of relation.statusChanges ?? []) {
    const at = asTime(change.createdAt);
    if (at > entered) entered = at;
  }
  return entered;
}

/** Whole days spent in the current stage. Never negative. */
export function daysInStage(relation: StageClockSource, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - stageEnteredAt(relation)) / DAY_MS));
}

/**
 * Fallback attention threshold, in calendar days. Used ONLY when the relation
 * carries no `stageDeadline` — i.e. the organisation has configured no SLA for
 * this stage (src/lib/stageSla.ts) and nobody typed a date in by hand. A
 * configured deadline always wins over this number.
 *
 * Why 30, and why a single flat number is necessarily a blunt one: the same
 * threshold has to cover a two-day approval wait and a months-long internship,
 * so it can only be wrong in the safe direction. At 30 days a candidate nobody
 * has moved is worth a second look in *every* stage, while ordinary progress
 * through the long stages does not light the whole board up amber. An
 * organisation that wants a real per-stage number sets Stage SLAs in admin
 * settings, and then this constant never applies to it.
 */
export const STAGE_ATTENTION_DAYS = 30;

/**
 * Stages whose clock has stopped, used when the caller has no resolved stages
 * at hand: the canonical terminal and off-path keys, plus HIRED_660.
 *
 * HIRED_660 is not flagged terminal in the canonical set (EMPLOYED_700 is), but
 * the candidate-detail chip has always excluded it and is right to — an
 * accepted offer is not a queue anybody is running late on.
 */
const CANONICAL_STOPPED = new Set<string>([
  ...defaultPipelineStages()
    .filter((s) => s.isTerminal || s.isOffPath)
    .map((s) => s.key),
  'HIRED_660',
]);

/**
 * Has this stage's clock stopped? Prefers the viewer's resolved stages so a
 * tenant's custom terminal/off-path stages are honored (#747), and falls back
 * to the canonical set when none were passed.
 */
export function stageClockStopped(
  pipelineStatus: string,
  stages?: ReadonlyArray<ResolvedStage> | null
): boolean {
  const stage = stages?.find((s) => s.key === pipelineStatus);
  if (stage) return stage.isTerminal || stage.isOffPath;
  return CANONICAL_STOPPED.has(pipelineStatus);
}

export type StageClockTone = 'normal' | 'attention' | 'overdue';

export interface StageClockInput {
  daysInStage: number;
  stageDeadline?: Date | string | null;
  pipelineStatus: string;
}

/**
 * How the clock should read to a mentor or an admin:
 *
 *   · `overdue`   — the organisation's stage deadline has passed.
 *   · `attention` — no deadline is configured at all and the relation has been
 *                   sitting here longer than STAGE_ATTENTION_DAYS.
 *   · `normal`    — everything else, including a stage whose clock has stopped.
 *
 * A relation with a deadline still in the future is `normal` however long it
 * has been there: the organisation said this stage takes that long.
 *
 * This is a mentor/admin-side classification. The mentee portal deliberately
 * never renders a breach state — see #1724.
 */
export function stageClockTone(
  input: StageClockInput,
  stages?: ReadonlyArray<ResolvedStage> | null,
  now: number = Date.now()
): StageClockTone {
  if (stageClockStopped(input.pipelineStatus, stages)) return 'normal';
  if (input.stageDeadline != null) {
    return asTime(input.stageDeadline) < now ? 'overdue' : 'normal';
  }
  return input.daysInStage >= STAGE_ATTENTION_DAYS ? 'attention' : 'normal';
}

/** Shorthand for the callers that only care about the breach state. */
export function isStageOverdue(
  input: StageClockInput,
  stages?: ReadonlyArray<ResolvedStage> | null,
  now: number = Date.now()
): boolean {
  return stageClockTone(input, stages, now) === 'overdue';
}
