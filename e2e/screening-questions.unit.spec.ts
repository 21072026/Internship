import { test, expect } from '@playwright/test';
import { parseScreeningQuestions, screeningQuestionsSchema, validateAnswers, type ScreeningQuestion } from '@/lib/screeningQuestions';

// Screening questions (#1832): the shape a requisition may store and the
// server-side check of a candidate's answers.

const label = { en: 'Q', tr: 'S', de: 'F' };
const questions: ScreeningQuestion[] = [
  { id: 'permit', type: 'BOOLEAN', label, required: true },
  { id: 'start', type: 'SELECT', label, options: ['Now', 'Later'], required: true },
  { id: 'why', type: 'TEXT', label, required: false },
];

test('a required question left blank, an unknown id or a value of the wrong type is refused', { tag: '@smoke' }, async () => {
  expect(validateAnswers(questions, { permit: true, start: 'Now' })).toEqual({ ok: true, answers: { permit: true, start: 'Now' } });
  expect(validateAnswers(questions, { permit: true, start: 'Now', why: '  ' })).toEqual({ ok: true, answers: { permit: true, start: 'Now' } });
  expect(validateAnswers(questions, { permit: true })).toMatchObject({ ok: false, code: 'required_missing', questionId: 'start' });
  expect(validateAnswers(questions, { permit: true, start: '' })).toMatchObject({ ok: false, code: 'required_missing' });
  expect(validateAnswers(questions, { permit: true, start: 'Never' })).toMatchObject({ ok: false, code: 'invalid_answer', questionId: 'start' });
  expect(validateAnswers(questions, { permit: 'yes', start: 'Now' })).toMatchObject({ ok: false, code: 'invalid_answer', questionId: 'permit' });
  expect(validateAnswers(questions, { permit: true, start: 'Now', salary: '1' })).toMatchObject({ ok: false, code: 'unknown_question', questionId: 'salary' });
  expect(validateAnswers([], undefined)).toEqual({ ok: true, answers: {} });
});

test('a requisition stores at most 8 well-formed questions with unique, path-safe ids', { tag: '@smoke' }, async () => {
  expect(screeningQuestionsSchema.safeParse(questions).success).toBe(true);
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, type: 'TEXT', label, required: false }));
  expect(screeningQuestionsSchema.safeParse(nine).success).toBe(false);
  expect(screeningQuestionsSchema.safeParse([{ id: 'a"b', type: 'TEXT', label, required: false }]).success).toBe(false);
  expect(screeningQuestionsSchema.safeParse([questions[0], questions[0]]).success).toBe(false);
  expect(screeningQuestionsSchema.safeParse([{ id: 'one', type: 'SELECT', label, options: ['Only'], required: true }]).success).toBe(false);
  expect(parseScreeningQuestions([questions[0], { junk: true }, 'x'])).toEqual([questions[0]]);
});
