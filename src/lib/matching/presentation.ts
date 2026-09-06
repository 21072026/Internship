/**
 * Pure presentation arithmetic for the match-score UI (#1785).
 *
 * Extracted out of `MatchScoreBreakdown.tsx` so it can be unit-tested without a
 * browser, a server or a page — the same shape as `e2e/ics-builder.unit.spec.ts`
 * and friends. These are the rules that decide what a coordinator sees, and the
 * component is a thin renderer over them:
 *
 *   • which tier (and therefore which colour) a pair lands in;
 *   • which rules count as *blocking* a pair, as opposed to merely failing;
 *   • the order the rule rows appear in.
 *
 * No React, no Prisma, no i18n — labels are resolved by the caller.
 */

import type { MatchBreakdownEntry } from './types';

export type MatchTier = 'blocked' | 'strong' | 'partial' | 'weak';

/** Green ≥ 70, amber 40-69, grey < 40 — and red whenever anything blocks. */
export function tierOf(score: number, blockedBy: readonly string[]): MatchTier {
  if (blockedBy.length > 0) return 'blocked';
  if (score >= 70) return 'strong';
  if (score >= 40) return 'partial';
  return 'weak';
}

/**
 * 0-100, integer. A non-finite score is shown as 0, not as `NaN`: an engine
 * that divides by a zero total weight (an empty or all-zero rule set is a real
 * state — the component renders a `noRules` branch for it) would otherwise
 * print "NaN%" *and* emit `stroke-dashoffset="NaN"`, which browsers read as 0
 * and draw as a full ring — a 100%-looking ring labelled NaN.
 */
export const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 0);

/** Points are displayed to one decimal at most — "12.5 pts", never "12.4999". */
export const fmtPoints = (n: number) => String(Number.isFinite(n) ? Math.round(n * 10) / 10 : 0);

/**
 * Is *this row* the reason the pair is blocked?
 *
 * `blockedBy` names dimensions, but a dimension can carry more than one rule —
 * a `HARD_REQUIRE` on `language` alongside a `WEIGHTED` one is legal, which is
 * why rows are keyed by dimension *and* kind. Marking every row on a blocked
 * dimension as blocking painted a passing weighted row red next to its own
 * green tick. Only a failed hard rule blocks.
 */
export function isBlockingRow(entry: MatchBreakdownEntry, blockedBy: readonly string[]): boolean {
  return blockedBy.includes(entry.dimension) && !entry.passed && entry.kind !== 'WEIGHTED';
}

/** Blocking rows first, otherwise input order. A block is the headline. */
export function orderRuleRows(
  breakdown: readonly MatchBreakdownEntry[],
  blockedBy: readonly string[]
): MatchBreakdownEntry[] {
  return [
    ...breakdown.filter((e) => isBlockingRow(e, blockedBy)),
    ...breakdown.filter((e) => !isBlockingRow(e, blockedBy)),
  ];
}

/**
 * The dimension that contributed the most points — the one line of "why" the
 * compact form has room for.
 *
 * Ranked by contribution alone. Ranking only `passed` rules named the wrong
 * dimension whenever a partially-matching rule carried the score (a 42-point
 * `skills` row losing the label to a 4-point `city` row), and named *nothing*
 * when no rule was marked passed — leaving the compact form as a bare
 * percentage, which this component may never render (see the header note).
 * Returns `null` only when there is nothing to point at: no rules, or none
 * that scored. The caller falls back to the tier name in that case.
 */
export function topFactor(breakdown: readonly MatchBreakdownEntry[]): MatchBreakdownEntry | null {
  const best = breakdown.reduce<MatchBreakdownEntry | null>(
    (acc, e) => (!acc || e.contribution > acc.contribution ? e : acc),
    null
  );
  return best && best.contribution > 0 ? best : null;
}
