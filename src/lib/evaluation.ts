// Rubric criteria (labels are localized in the UI).
// Mentor-on-mentee evaluation:
export const EVAL_CRITERIA = ['technical', 'communication', 'reliability', 'growth'] as const;
export type EvalCriterion = (typeof EVAL_CRITERIA)[number];

// Mentee-on-mentor (two-way) evaluation:
export const MENTOR_CRITERIA = ['guidance', 'availability', 'expertise', 'support'] as const;
export type MentorCriterion = (typeof MENTOR_CRITERIA)[number];

type ScoreSet = Record<string, unknown>;

// One scoring rule for both an individual mentor review and a collection of
// reviews. Only the mentee-on-mentor rubric contributes to the result.
export function mentorFeedbackAverage(scores: ScoreSet | ScoreSet[]): number | null {
  const sets = Array.isArray(scores) ? scores : [scores];
  const values = sets.flatMap((set) =>
    MENTOR_CRITERIA.map((criterion) => set[criterion]).filter(
      (value): value is number => typeof value === 'number' && value >= 1 && value <= 5
    )
  );
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

// Union of every valid criterion key, for server-side score validation.
export const ALL_CRITERIA = [...EVAL_CRITERIA, ...MENTOR_CRITERIA] as const;

export const EVALUATION_TYPES = ['INTERIM', 'FINAL'] as const;
