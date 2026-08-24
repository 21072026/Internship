// Rubric criteria (labels are localized in the UI).
//
// These four-plus-four are the *defaults*, not the law: since #822 an org can
// define its own competency framework in the DB (EvaluationTemplate /
// EvaluationCriterion) and this list is what an org that defined nothing keeps
// using — which is every existing installation, unchanged.
//
// This file stays client-safe: no Prisma, no server-only imports. The DB-backed
// resolver lives in src/lib/evaluationTemplates.ts (server-only) and the client
// hooks in src/lib/evaluationCriteriaClient.tsx, exactly the split #747 used for
// pipeline stages.

// Mentor-on-mentee evaluation:
export const EVAL_CRITERIA = ['technical', 'communication', 'reliability', 'growth'] as const;
export type EvalCriterion = (typeof EVAL_CRITERIA)[number];

// Mentee-on-mentor (two-way) evaluation:
export const MENTOR_CRITERIA = ['guidance', 'availability', 'expertise', 'support'] as const;
export type MentorCriterion = (typeof MENTOR_CRITERIA)[number];

// Union of every built-in criterion key. Still the fallback whitelist for
// score validation when an org has no template of its own.
export const ALL_CRITERIA = [...EVAL_CRITERIA, ...MENTOR_CRITERIA] as const;

export const EVALUATION_TYPES = ['INTERIM', 'FINAL'] as const;

// Which side of the relationship a rubric scores.
export const EVALUATION_SCOPES = ['MENTEE', 'MENTOR'] as const;
export type EvaluationScope = (typeof EVALUATION_SCOPES)[number];

export function isEvaluationScope(value: string): value is EvaluationScope {
  return (EVALUATION_SCOPES as readonly string[]).includes(value);
}

/**
 * One criterion as the UI receives it.
 *
 * `labels: null` marks a built-in criterion, whose wording lives in the
 * dictionary and is therefore localized in the *viewer's* language. A custom
 * criterion carries the tenant's own strings per language.
 */
export interface ResolvedCriterion {
  key: string;
  order: number;
  labels: Record<string, string> | null;
  active: boolean;
}

const builtIn = (keys: readonly string[]): ResolvedCriterion[] =>
  keys.map((key, order) => ({ key, order, labels: null, active: true }));

/** The built-in rubric for a scope — what an org with no template of its own uses. */
export function defaultCriteria(scope: EvaluationScope): ResolvedCriterion[] {
  return builtIn(scope === 'MENTOR' ? MENTOR_CRITERIA : EVAL_CRITERIA);
}

/**
 * A criterion's label, given the viewer's locale and the dictionary's built-in
 * labels. Custom labels degrade language by language — a framework translated
 * into two of three languages still renders in the third rather than vanishing.
 */
export function criterionLabel(
  criterion: ResolvedCriterion,
  locale: string,
  builtInLabels: Record<string, string>
): string {
  if (criterion.labels) {
    return criterion.labels[locale] || criterion.labels.en || criterion.key;
  }
  return builtInLabels[criterion.key] ?? criterion.key;
}

/** Renders scores that no longer belong to any criterion rather than dropping them. */
export function criteriaForScores(
  criteria: ResolvedCriterion[],
  scores: Record<string, number>
): ResolvedCriterion[] {
  const known = new Set(criteria.map((c) => c.key));
  const orphans = Object.keys(scores)
    .filter((k) => !known.has(k))
    .map((key, i) => ({ key, order: criteria.length + i, labels: null, active: false }));
  return [...criteria, ...orphans].filter((c) => scores[c.key] !== undefined);
}
