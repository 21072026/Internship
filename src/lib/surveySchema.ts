// Survey question types and answer validation (#1879) — client-safe. A survey
// question is a form field (src/lib/forms/schema.ts) plus NPS; NPS is the
// standard 0..10 "how likely are you to recommend" scale, so it is validated
// as a SCALE from 0 to 10 through the same validator, never a second one.

import { FORM_FIELD_TYPES, validateResponse, type FormFieldDef, type FormFieldOption, type ValidationErrorKey } from '@/lib/forms/schema';

export const SURVEY_QUESTION_TYPES = [...FORM_FIELD_TYPES, 'NPS'] as const;
export type SurveyQuestionType = (typeof SURVEY_QUESTION_TYPES)[number];

export function isSurveyQuestionType(value: unknown): value is SurveyQuestionType {
  return typeof value === 'string' && (SURVEY_QUESTION_TYPES as readonly string[]).includes(value);
}

export const NPS_SCALE = { min: 0, max: 10 } as const;

/** A question key: lower snake case, stable — it is the answer join key. */
export const QUESTION_KEY_RE = /^[a-z][a-z0-9_]{0,79}$/;

export interface SurveyQuestionDef {
  key: string;
  type: SurveyQuestionType;
  required?: boolean;
  options?: FormFieldOption[] | null;
}

export function toFieldDef(q: SurveyQuestionDef): FormFieldDef {
  return q.type === 'NPS'
    ? { key: q.key, type: 'SCALE', required: q.required, scale: NPS_SCALE }
    : { key: q.key, type: q.type, required: q.required, options: q.options };
}

export function validateSurveyAnswer(q: SurveyQuestionDef, value: unknown): ValidationErrorKey | null {
  return validateResponse(toFieldDef(q), value);
}
