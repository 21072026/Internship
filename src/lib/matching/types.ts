/**
 * Prop-level types for the matching UI (#1785).
 *
 * These mirror exactly what `scoreMatch()` (#1781, `src/lib/matching/score.ts`)
 * is specified to return. They live in their own module — no Prisma, no server
 * imports — so a presentational component can depend on the *shape* of a score
 * without waiting for, or pulling in, the engine that produces it.
 *
 * Client-safe on purpose: nothing here may ever import `@prisma/client`.
 */

/** How a rule participates in the score. Mirrors the `MatchRuleKind` enum. */
export type MatchRuleKind = 'WEIGHTED' | 'HARD_REQUIRE' | 'HARD_EXCLUDE';

/**
 * The dimensions the rule registry knows about (#1781). Widened to `string` on
 * the wire — an org can be running a rule set written against a newer registry
 * than the client bundle, and an unknown dimension must render as its raw key
 * rather than crash or silently disappear from an explanation.
 */
export const MATCH_DIMENSIONS = [
  'skills',
  'language',
  'field',
  'department',
  'university',
  'city',
  'timezone',
  'capacityHeadroom',
  'managerExclusion',
  'previousPairing',
] as const;

export type MatchDimension = (typeof MATCH_DIMENSIONS)[number];

/** One evaluated rule: what it is, whether it held, and what it contributed. */
export interface MatchBreakdownEntry {
  /** Registry key, e.g. `skills`. A key outside `MATCH_DIMENSIONS` is allowed. */
  dimension: string;
  kind: MatchRuleKind;
  /** Configured weight, 0-100. Meaningless (0) for hard rules. */
  weight: number;
  /** How much of the dimension matched, 0-1. */
  ratio: number;
  /** Points this rule added to the total score, 0-100. */
  contribution: number;
  passed: boolean;
  /** Human-readable evidence, e.g. the actually-shared skills. */
  detail: string[];
}

/** The full result of `scoreMatch(mentee, mentor, ruleSet)`. */
export interface MatchScore {
  /** 0-100. Forced to 0 whenever `blockedBy` is non-empty. */
  score: number;
  breakdown: MatchBreakdownEntry[];
  /**
   * Dimensions of the `HARD_REQUIRE` / `HARD_EXCLUDE` rules that rejected this
   * pair. Non-empty means "not available at all", which is a different outcome
   * from a low score and must never be rendered as one.
   */
  blockedBy: string[];
}
