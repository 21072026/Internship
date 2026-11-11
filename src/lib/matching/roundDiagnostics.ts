/**
 * "Why did these eleven people get nobody?" (#1796) — the pure half of the
 * round board's unmatched panel. No Prisma: the route loads the round's
 * proposals, the unmatched mentees' skills and the pool's headroom, and this
 * file turns them into the two signals a stuck coordinator needs:
 *
 *   - the rules are too tight: unmatched mentees grouped by reason, and the
 *     hard rule that blocked the most (mentee × mentor) pairs in the pass
 *     (`stats.blockedPairsByRule`, written by `assign.ts`);
 *   - there are not enough mentors: per skill the unmatched mentees list, how
 *     many of them need it against how many mentors who hold it still have
 *     headroom — "14 mentees need Python; 2 mentors have room".
 *
 * Skills are compared as the people typed them, trimmed and lower-cased — the
 * same reading the default rule set's `skills` dimension uses.
 */

import { UNMATCHED_REASONS, type UnmatchedReason } from './round';

export const SHORTAGE_LIMIT = 5;

export interface DiagnosticsInput {
  proposals: readonly { menteeId: string; mentorId: string | null; unmatchedReason: string | null }[];
  /** Free-text skills per unmatched mentee. */
  menteeSkills: ReadonlyMap<string, readonly string[]>;
  /** The pool after the round's own reservations; null headroom = no ceiling. */
  mentors: readonly { id: string; skills: readonly string[]; headroomLeft: number | null }[];
  blockedPairsByRule?: Readonly<Record<string, number>> | null;
}

export interface RoundDiagnostics {
  unmatchedTotal: number;
  byReason: { reason: UnmatchedReason; count: number; menteeIds: string[] }[];
  /** The hard rule that blocked the most pairs; null when no rule blocked any. */
  topRule: { rule: string; pairs: number } | null;
  shortages: { skill: string; mentees: number; mentorsWithHeadroom: number }[];
}

const fold = (s: string) => s.trim().toLowerCase();
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function roundDiagnostics(input: DiagnosticsInput): RoundDiagnostics {
  const unmatched = input.proposals.filter((p) => p.mentorId === null);

  const groups = new Map<UnmatchedReason, string[]>();
  for (const p of unmatched) {
    const reason = (UNMATCHED_REASONS as readonly string[]).includes(p.unmatchedReason ?? '')
      ? (p.unmatchedReason as UnmatchedReason)
      : null;
    if (!reason) continue;
    groups.set(reason, [...(groups.get(reason) ?? []), p.menteeId]);
  }
  const byReason = UNMATCHED_REASONS.filter((r) => groups.has(r)).map((reason) => ({
    reason,
    count: groups.get(reason)!.length,
    menteeIds: [...groups.get(reason)!].sort(byCode),
  }));

  const rules = Object.entries(input.blockedPairsByRule ?? {}).filter(([, n]) => n > 0);
  rules.sort(([a, x], [b, y]) => y - x || byCode(a, b));
  const topRule = rules.length ? { rule: rules[0][0], pairs: rules[0][1] } : null;

  // Skill → how many unmatched mentees list it (once per mentee), with the
  // label as first written.
  const need = new Map<string, { label: string; mentees: number }>();
  for (const p of unmatched) {
    const seen = new Set<string>();
    for (const raw of input.menteeSkills.get(p.menteeId) ?? []) {
      const key = fold(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const cur = need.get(key);
      need.set(key, { label: cur?.label ?? raw.trim(), mentees: (cur?.mentees ?? 0) + 1 });
    }
  }
  const roomy = input.mentors.filter((m) => m.headroomLeft === null || m.headroomLeft > 0);
  const shortages = [...need.entries()]
    .map(([key, { label, mentees }]) => ({
      skill: label,
      mentees,
      mentorsWithHeadroom: roomy.filter((m) => m.skills.some((s) => fold(s) === key)).length,
    }))
    .filter((s) => s.mentees > s.mentorsWithHeadroom)
    .sort((a, b) => b.mentees - b.mentorsWithHeadroom - (a.mentees - a.mentorsWithHeadroom) || b.mentees - a.mentees || byCode(a.skill, b.skill))
    .slice(0, SHORTAGE_LIMIT);

  return { unmatchedTotal: unmatched.length, byReason, topRule, shortages };
}
