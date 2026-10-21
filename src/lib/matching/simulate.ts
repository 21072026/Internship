/**
 * Dry-run simulation of a rule set (#1783). PURE and client-safe: it scores
 * plain objects with scoreMatch() and counts — it never writes a relation, a
 * proposal or a decision. The route (/api/admin/matching/simulate) loads the
 * people; this decides what the "your rules are too tight" panel says.
 */

import { getMentorAvailability } from '@/lib/mentorAvailability';
import type { MatchScore } from './types';
import type { MatchMentee, MatchMentor, ScoreContext } from './dimensions';
import { rankMatches, type MatchRuleInput, type MatchRuleSetInput } from './score';

export interface Elimination {
  dimension: string;
  /** How many (mentee, mentor) pairs this rule blocked. */
  count: number;
}

export interface SimulatedMentee {
  menteeId: string;
  fullName: string;
  /** Mentors no hard rule blocks. */
  eligible: number;
  top: { mentorId: string; fullName: string; match: MatchScore }[];
  /** The hard rule that blocked the most mentors for this mentee; null when none blocked anyone. */
  mostEliminating: Elimination | null;
}

export interface SimulationSummary {
  mentees: number;
  withEligible: number;
  mentors: number;
  mentorsAtCapacity: number;
  /** Across every mentee: the hard rule that blocked the most pairs. */
  mostEliminating: Elimination | null;
}

type Named = { fullName: string };

/** The dimension with the highest count; ties go to the first seen. */
function top(counts: Map<string, number>): Elimination | null {
  let best: Elimination | null = null;
  for (const [dimension, count] of counts) if (!best || count > best.count) best = { dimension, count };
  return best;
}

export function simulateRuleSet(
  mentees: readonly (MatchMentee & Named)[],
  mentors: readonly (MatchMentor & Named)[],
  ruleSet: MatchRuleSetInput,
  opts: { topN?: number; ctx?: ScoreContext } = {}
): { results: SimulatedMentee[]; summary: SimulationSummary } {
  const topN = opts.topN ?? 5;
  const ctx = opts.ctx ?? { now: new Date() };
  const overall = new Map<string, number>();

  const results = mentees.map((mentee) => {
    const ranked = rankMatches(mentee, mentors.filter((m) => m.id !== mentee.id), ruleSet, ctx);
    const local = new Map<string, number>();
    for (const r of ranked) {
      for (const d of r.match.blockedBy) {
        local.set(d, (local.get(d) ?? 0) + 1);
        overall.set(d, (overall.get(d) ?? 0) + 1);
      }
    }
    const eligible = ranked.filter((r) => r.match.blockedBy.length === 0);
    return {
      menteeId: mentee.id,
      fullName: mentee.fullName,
      eligible: eligible.length,
      top: eligible.slice(0, topN).map((r) => ({ mentorId: r.mentor.id, fullName: r.mentor.fullName, match: r.match })),
      mostEliminating: top(local),
    };
  });

  const mentorsAtCapacity = mentors.filter(
    (m) =>
      getMentorAvailability({ mentorCapacity: m.mentorCapacity, activeMenteeCount: m.activeMenteeCount, acceptingMentees: undefined })
        .status === 'at_capacity'
  ).length;

  return {
    results,
    summary: {
      mentees: results.length,
      withEligible: results.filter((r) => r.eligible > 0).length,
      mentors: mentors.length,
      mentorsAtCapacity,
      mostEliminating: top(overall),
    },
  };
}

/**
 * The weights as the share of the score each WEIGHTED rule can carry, in
 * whole percent that always sum to 100 (largest remainder) — so 30/30/30
 * reads 34/33/33, never 33/33/33 = 99. Hard rules and all-zero sets read 0.
 */
export function normalizedWeights(rules: readonly Pick<MatchRuleInput, 'kind' | 'weight'>[]): number[] {
  const w = rules.map((r) => (r.kind === 'WEIGHTED' && Number.isFinite(r.weight) ? Math.max(0, Math.min(100, r.weight)) : 0));
  const total = w.reduce((a, b) => a + b, 0);
  if (total === 0) return w.map(() => 0);
  const exact = w.map((x) => (x * 100) / total);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, rem: x - Math.floor(x) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (w[i] > 0) { floors[i] += 1; left -= 1; }
  }
  return floors;
}
