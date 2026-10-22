// Screening questions on a requisition and the answers to them (#1832) — pure,
// so the editor, the apply modal and the routes read the same rules.
//
// A question: { id, type: TEXT | BOOLEAN | SELECT, label: { en, tr, de },
// options? (SELECT only), required }. At most 8 per requisition. Answers are an
// object keyed by question id — the shape the applicant board filters on
// (`answer.<id>=<value>`, src/lib/requisitionBoard.ts) — so the id alphabet is
// the one that board accepts in a JSON path.
import { z } from 'zod';

export const SCREENING_QUESTION_TYPES = ['TEXT', 'BOOLEAN', 'SELECT'] as const;
export type ScreeningQuestionType = (typeof SCREENING_QUESTION_TYPES)[number];

export const SCREENING_LIMITS = { questions: 8, label: 200, options: 10, option: 100, textAnswer: 1000, coverNote: 4000 } as const;

const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const label = z.string().trim().min(1).max(SCREENING_LIMITS.label);

export const screeningQuestionSchema = z.object({
  id: z.string().regex(QUESTION_ID),
  type: z.enum(SCREENING_QUESTION_TYPES),
  label: z.object({ en: label, tr: label, de: label }).strict(),
  options: z.array(z.string().trim().min(1).max(SCREENING_LIMITS.option)).max(SCREENING_LIMITS.options).optional(),
  required: z.boolean(),
}).strict().refine((q) => q.type !== 'SELECT' || (q.options?.length ?? 0) >= 2, { message: 'A choice question needs at least two options' });

export const screeningQuestionsSchema = z
  .array(screeningQuestionSchema)
  .max(SCREENING_LIMITS.questions)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, { message: 'Question ids must be unique' });

export type ScreeningQuestion = z.infer<typeof screeningQuestionSchema>;

/** The stored JSON as questions, dropping anything malformed rather than trusting it. */
export function parseScreeningQuestions(value: unknown): ScreeningQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((q) => {
    const parsed = screeningQuestionSchema.safeParse(q);
    return parsed.success ? [parsed.data] : [];
  });
}

export type AnswerError = 'unknown_question' | 'required_missing' | 'invalid_answer';
export type ScreeningAnswers = Record<string, string | boolean>;

/**
 * The answers checked against the requisition's questions, server-side: every
 * required question answered, no id the requisition does not ask, each value
 * of its question's type (a SELECT answer is one of its options, a TEXT answer
 * at most 1000 characters). Empty strings count as unanswered.
 */
export function validateAnswers(questions: readonly ScreeningQuestion[], raw: unknown): { ok: true; answers: ScreeningAnswers } | { ok: false; code: AnswerError; questionId?: string } {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const byId = new Map(questions.map((q) => [q.id, q]));
  for (const id of Object.keys(input)) if (!byId.has(id)) return { ok: false, code: 'unknown_question', questionId: id };
  const answers: ScreeningAnswers = {};
  for (const q of questions) {
    let value = input[q.id];
    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === null || value === '') {
      if (q.required) return { ok: false, code: 'required_missing', questionId: q.id };
      continue;
    }
    if (q.type === 'BOOLEAN' && typeof value !== 'boolean') return { ok: false, code: 'invalid_answer', questionId: q.id };
    if (q.type === 'TEXT' && (typeof value !== 'string' || value.length > SCREENING_LIMITS.textAnswer)) return { ok: false, code: 'invalid_answer', questionId: q.id };
    if (q.type === 'SELECT' && (typeof value !== 'string' || !(q.options ?? []).includes(value))) return { ok: false, code: 'invalid_answer', questionId: q.id };
    answers[q.id] = value as string | boolean;
  }
  return { ok: true, answers };
}
