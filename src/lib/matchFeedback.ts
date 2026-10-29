// Mentor-matching feedback loop (#2040). Client-safe — no Prisma import — so
// the API route, the dismiss control and the analytics card all share one
// vocabulary. Validated the repo's usual way: z.string() + a whitelist, never
// z.enum (CLAUDE.md).

// Why an admin threw a suggestion away. Deliberately short: a picker with five
// options gets used, a picker with fifteen gets "Other" every time. Free text
// still travels alongside the code (MatchFeedback.reasonNote) so nothing is
// lost, but only the code is aggregated.
export const MATCH_DISMISS_REASONS = [
  'WRONG_FIELD',
  'NO_CAPACITY',
  'LANGUAGE',
  'ALREADY_MATCHED',
  'OTHER',
] as const;

export type MatchDismissReason = (typeof MATCH_DISMISS_REASONS)[number];

export function isMatchDismissReason(value: string): value is MatchDismissReason {
  return (MATCH_DISMISS_REASONS as readonly string[]).includes(value);
}

// Outcomes the feedback route accepts. SHOWN is written by the suggest route
// itself and is not a client-reportable outcome — a client claiming "SHOWN"
// would only ever be overwriting a real decision with a non-decision.
export const MATCH_FEEDBACK_OUTCOMES = ['ACCEPTED', 'DISMISSED'] as const;

export type MatchFeedbackOutcome = (typeof MATCH_FEEDBACK_OUTCOMES)[number];

export function isMatchFeedbackOutcome(value: string): value is MatchFeedbackOutcome {
  return (MATCH_FEEDBACK_OUTCOMES as readonly string[]).includes(value);
}

// Which ranking produced a recorded suggestion. Bump this whenever the ordering
// in /api/admin/mentor-suggest changes materially — that is the only way a
// later "did the new ranking do better?" question can be answered from the
// rows we are storing today.
//
//   rules-v1 — skill overlap desc, then active-mentee count asc, capacity-full
//              mentors excluded; optionally re-ranked by the AI gate.
//   rules-v2 — (#1821) adjacency-weighted overlap of canonical skills
//              (skillOverlap: exact 1, neighbour = SkillEdge weight) desc, free
//              text exact match only for a mentee with no canonical skills;
//              then load, capacity and the AI re-rank as in v1.
export const MATCH_RULESET_VERSION = 'rules-v2';

/**
 * rules-v3 (#1787): the score is `scoreMatch()` with the org's rule set (#1781)
 * — the `skills` dimension on canonical ids with adjacency, as v2 — so the
 * recorded tag names WHICH rule set and version ranked the list:
 * `rules-v3:<ruleSetId|default>@<version>`. Fits the VarChar(64) column.
 */
export function matchRuleSetTag(ruleSet: { id: string | null; version: number }): string {
  return `rules-v3:${ruleSet.id ?? 'default'}@${ruleSet.version}`.slice(0, 64);
}

// Free-text note cap. Long enough for a sentence of context, short enough that
// the column stays a note rather than a second CRM.
export const MATCH_REASON_NOTE_MAX = 300;

// Sentinel for DISMISSED rows written before/without a reason code (or by a
// client that sent none) — grouped as "Unspecified" in the report rather than
// silently dropped from the totals.
export const MATCH_REASON_UNSPECIFIED = 'UNSPECIFIED';
