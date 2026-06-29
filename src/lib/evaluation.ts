// Rubric criteria (labels are localized in the UI).
// Mentor-on-mentee evaluation:
export const EVAL_CRITERIA = ['technical', 'communication', 'reliability', 'growth'] as const;
export type EvalCriterion = (typeof EVAL_CRITERIA)[number];

// Mentee-on-mentor (two-way) evaluation:
export const MENTOR_CRITERIA = ['guidance', 'availability', 'expertise', 'support'] as const;
export type MentorCriterion = (typeof MENTOR_CRITERIA)[number];

// Union of every valid criterion key, for server-side score validation.
export const ALL_CRITERIA = [...EVAL_CRITERIA, ...MENTOR_CRITERIA] as const;

export const EVALUATION_TYPES = ['INTERIM', 'FINAL'] as const;
