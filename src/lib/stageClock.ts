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
 * Stages whose clock has stopped, used when the caller has no resolved stages
 * at hand: the canonical terminal and off-path keys.
 */
const CANONICAL_STOPPED = new Set<string>(
  defaultPipelineStages()
    .filter((s) => s.isTerminal || s.isOffPath)
    .map((s) => s.key)
);

/**
 * Stages whose clock has stopped whatever the tenant's own flags say.
 *
 * HIRED_660 is not flagged terminal in the canonical set (EMPLOYED_700 is) and
 * a tenant's `PipelineStage` row for it will not be either, because the flag
 * means "the journey ended here" and a hire is followed by employment. The
 * clock still has to stop: an accepted offer is not a queue anybody is running
 * late on, which is exactly why the candidate-detail chip has excluded
 * `['HIRED_660','EMPLOYED_700']` since long before this module existed
 * (src/app/admin/candidates/[id]/page.tsx) and why #1724 names that rule as the
 * one every surface must match.
 *
 * This deliberately sits OUTSIDE the resolved-stage lookup below. Putting it in
 * the fallback set (where it used to live) made it dead code: every UI caller
 * passes `useResolvedStages()`, which never yields an empty list, so the lookup
 * always won and a hired candidate with a stale `stageDeadline` still rendered
 * the red "past the stage deadline" chip.
 */
const ALWAYS_STOPPED = new Set<string>(['HIRED_660']);

/**
 * Has this stage's clock stopped? Prefers the viewer's resolved stages so a
 * tenant's custom terminal/off-path stages are honored (#747), and falls back
 * to the canonical set when none were passed.
 */
export function stageClockStopped(
  pipelineStatus: string,
  stages?: ReadonlyArray<ResolvedStage> | null
): boolean {
  if (ALWAYS_STOPPED.has(pipelineStatus)) return true;
  const stage = stages?.find((s) => s.key === pipelineStatus);
  if (stage) return stage.isTerminal || stage.isOffPath;
  return CANONICAL_STOPPED.has(pipelineStatus);
}

export type StageClockTone = 'normal' | 'overdue';

export interface StageClockInput {
  stageDeadline?: Date | string | null;
  pipelineStatus: string;
  /**
   * The clock is paused for this relation and can never read as a breach.
   *
   * Today that means one thing: the mentee is in the re-engagement pool (#834),
   * i.e. somebody made an explicit "we'll write in September" arrangement with
   * them. The admin aging report drops those people from `overdue` for exactly
   * that reason — they are not stuck, and a breach list half full of people who
   * will not move is a list nobody reads. Alerting the mentor about a queue
   * item they were told not to chase is the same mistake on a smaller screen.
   *
   * Server-derived (the pool date lives on the User, not the relation), so the
   * callers that have it pass it and the ones that do not simply get the
   * deadline rule.
   */
  paused?: boolean;
}

/**
 * How the clock should read to a mentor or an admin: `overdue` once the
 * organisation's stage deadline has passed, `normal` otherwise.
 *
 * There is deliberately no middle "this looks stale" tier keyed on elapsed days
 * alone. Stage SLAs are opt-in, so on a default install no relation has a
 * `stageDeadline` at all, and a flat day count cannot tell a two-day approval
 * wait from a four-month internship: every INTERNSHIP_IN_PROGRESS_450 and
 * JOB_SEEKING_500 card would light up as soon as it crossed the threshold, and
 * a board that is mostly amber says nothing. A per-stage version of that idea
 * has a real source of truth to build on — the observed median dwell that
 * `computeStageAging` already produces — and belongs in its own change.
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
  if (input.paused) return 'normal';
  if (stageClockStopped(input.pipelineStatus, stages)) return 'normal';
  if (input.stageDeadline == null) return 'normal';
  return asTime(input.stageDeadline) < now ? 'overdue' : 'normal';
}

/** Shorthand for the callers that only care about the breach state. */
export function isStageOverdue(
  input: StageClockInput,
  stages?: ReadonlyArray<ResolvedStage> | null,
  now: number = Date.now()
): boolean {
  return stageClockTone(input, stages, now) === 'overdue';
}
