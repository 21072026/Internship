/**
 * scoreMatch() — "how well do these two fit, and which rules held" (#1781).
 *
 * PURE: no Prisma, no I/O, no clock of its own (the zone offsets read
 * `ctx.now`). It runs in a unit test with plain objects and in a browser
 * preview of an unsaved rule set. The server-side lookup of an org's rule set
 * is `resolveRuleSet()` in ./ruleSet.ts.
 *
 * Arithmetic: every WEIGHTED rule contributes `100 × weight × ratio / Σweight`,
 * so the contributions sum to the score and the score is 0-100. A failed
 * HARD_REQUIRE or a hit HARD_EXCLUDE sets the score — and every contribution —
 * to 0 and names the dimension in `blockedBy`: a blocked pair is a different
 * outcome from a weak one and is never dropped in silence.
 *
 * Nothing here assigns anybody. It ranks; a person decides.
 */

import { SOFT_ONLY_DIMENSIONS, type MatchBreakdownEntry, type MatchRuleKind, type MatchScore } from './types';
import { evaluateDimension, type MatchMentee, type MatchMentor, type ScoreContext } from './dimensions';

export interface MatchRuleInput {
  dimension: string;
  kind: MatchRuleKind;
  /** 0-100; clamped. Only WEIGHTED rules read it. */
  weight: number;
  config?: Record<string, unknown> | null;
}

export interface MatchRuleSetInput {
  /** Null for the built-in default. */
  id: string | null;
  name: string;
  version: number;
  rules: readonly MatchRuleInput[];
}

/**
 * The pre-#1781 mentor-suggest ranking, as a rule set: skill overlap is the
 * whole score (pre-#1781 compared lower-cased strings and nothing else, hence
 * `mode: 'lowercase'`), a mentor at their headcount ceiling is blocked, and
 * ties go to the lighter load (`compareMatches`). An org that configures
 * nothing ranks exactly as before.
 */
export const DEFAULT_RULE_SET: MatchRuleSetInput = Object.freeze({
  id: null,
  name: 'Default',
  version: 1,
  rules: Object.freeze([
    { dimension: 'skills', kind: 'WEIGHTED' as const, weight: 100, config: { mode: 'lowercase' } },
    { dimension: 'capacityHeadroom', kind: 'HARD_REQUIRE' as const, weight: 0, config: {} },
  ]),
});

const clampWeight = (w: number) => (Number.isFinite(w) ? Math.min(100, Math.max(0, Math.round(w))) : 0);

/** A set with no rules scores as the default — never as "everybody 0". */
export function effectiveRuleSet(ruleSet: MatchRuleSetInput | null | undefined): MatchRuleSetInput {
  return ruleSet && ruleSet.rules.length > 0 ? ruleSet : DEFAULT_RULE_SET;
}

export function scoreMatch(
  mentee: MatchMentee,
  mentor: MatchMentor,
  ruleSet?: MatchRuleSetInput | null,
  ctx: ScoreContext = { now: new Date() }
): MatchScore {
  // A soft-only dimension never blocks (#2038), whatever kind a row says.
  const rules = effectiveRuleSet(ruleSet).rules.map((r) => (SOFT_ONLY_DIMENSIONS.includes(r.dimension) && r.kind !== 'WEIGHTED' ? { ...r, kind: 'WEIGHTED' as const } : r));
  const totalWeight = rules.reduce((sum, r) => sum + (r.kind === 'WEIGHTED' ? clampWeight(r.weight) : 0), 0);

  const blockedBy: string[] = [];
  const breakdown: MatchBreakdownEntry[] = rules.map((rule) => {
    const result = evaluateDimension(rule.dimension, mentee, mentor, rule.config ?? {}, ctx);
    const applicable = result.applicable !== false;
    const weight = rule.kind === 'WEIGHTED' ? clampWeight(rule.weight) : 0;
    let passed: boolean;
    if (rule.kind === 'WEIGHTED') passed = result.matched;
    else if (rule.kind === 'HARD_REQUIRE') passed = !applicable || result.matched;
    else passed = !applicable || !result.matched;
    if (!passed && rule.kind !== 'WEIGHTED' && !blockedBy.includes(rule.dimension)) blockedBy.push(rule.dimension);
    return {
      dimension: rule.dimension,
      kind: rule.kind,
      weight,
      ratio: result.ratio,
      contribution: totalWeight > 0 ? (100 * weight * result.ratio) / totalWeight : 0,
      passed,
      detail: result.detail,
    };
  });

  if (blockedBy.length > 0) {
    return { score: 0, breakdown: breakdown.map((e) => ({ ...e, contribution: 0 })), blockedBy };
  }
  const score = breakdown.reduce((sum, e) => sum + e.contribution, 0);
  return { score: Math.min(100, Math.max(0, score)), breakdown, blockedBy };
}

export interface RankedMatch<M extends MatchMentor = MatchMentor> {
  mentor: M;
  match: MatchScore;
}

/** Unblocked first, higher score first, then the lighter load. Stable otherwise. */
export function compareMatches(a: RankedMatch, b: RankedMatch): number {
  const blocked = Number(a.match.blockedBy.length > 0) - Number(b.match.blockedBy.length > 0);
  if (blocked !== 0) return blocked;
  if (a.match.score !== b.match.score) return b.match.score - a.match.score;
  return a.mentor.activeMenteeCount - b.mentor.activeMenteeCount;
}

/** Score every mentor for one mentee and rank them. Blocked pairs are kept, last. */
export function rankMatches<M extends MatchMentor>(
  mentee: MatchMentee,
  mentors: readonly M[],
  ruleSet?: MatchRuleSetInput | null,
  ctx: ScoreContext = { now: new Date() }
): RankedMatch<M>[] {
  return mentors.map((mentor) => ({ mentor, match: scoreMatch(mentee, mentor, ruleSet, ctx) })).sort(compareMatches);
}
