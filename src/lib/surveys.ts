// The survey write boundary (#1879): creating and editing a survey, and
// recording a response. Every rule that protects an answer is enforced HERE,
// at the write, so no route or job can get it wrong:
//
//   • A question's key and type are frozen once the survey has left DRAFT —
//     an answer is joined to its question by key, so a renamed key would
//     orphan every answer already given (409 `questions_locked`).
//   • An ANONYMOUS response is written with respondentId and invitationId
//     NULL. The link between a person and their answer never reaches the
//     database; completion is tracked on the invitation instead.
//   • The response floor can be raised per survey, never lowered.
//   • Invitation tokens are stored as a SHA-256 hash only.
//
// Who may READ what is src/lib/surveyPrivacy.ts. docs/surveys.md is the design.

import { createHash, randomBytes } from 'crypto';
import { Prisma, type SurveyAnonymity, type SurveyAudience, type SurveyStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { SURVEY_MIN_RESPONSES } from '@/lib/surveyPrivacy';
import { isSurveyQuestionType, QUESTION_KEY_RE, validateSurveyAnswer, type SurveyQuestionType } from '@/lib/surveySchema';
import type { ValidationErrorKey } from '@/lib/forms/schema';

/** A write the current state refuses — the route answers 409 with `code`. */
export class SurveyConflict extends Error {
  constructor(public code: 'questions_locked' | 'reopen_draft' | 'not_open' | 'already_responded') {
    super(code);
  }
}

/** An answer that fails validation — the route answers 400 with the field errors. */
export class SurveyAnswerInvalid extends Error {
  constructor(public errors: Record<string, ValidationErrorKey | 'unknown_question'>) {
    super('invalid_answers');
  }
}

const localized = z
  .object({ en: z.string().trim().max(500).optional(), tr: z.string().trim().max(500).optional(), de: z.string().trim().max(500).optional() })
  .strict()
  .refine((v) => !!(v.en || v.tr || v.de), 'at least one language');

const optionSchema = z.object({ value: z.string().trim().min(1).max(80), labels: localized }).strict();

const questionSchema = z
  .object({
    key: z.string().regex(QUESTION_KEY_RE),
    type: z.string().refine(isSurveyQuestionType, 'unknown type'),
    labels: localized,
    helpText: localized.nullable().optional(),
    options: z.array(optionSchema).max(30).nullable().optional(),
    required: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((q) => (q.type === 'SELECT' || q.type === 'MULTI_SELECT' ? (q.options?.length ?? 0) > 0 : true), 'choice questions need options');

const questionsSchema = z
  .array(questionSchema)
  .min(1)
  .max(30)
  .refine((qs) => new Set(qs.map((q) => q.key)).size === qs.length, 'question keys must be unique');

// String + whitelist rather than z.enum, the house rule for enum-like input.
const AUDIENCES = ['MENTEE', 'MENTOR', 'BOTH', 'COMPANY'] as const;
const ANONYMITIES = ['IDENTIFIED', 'CONFIDENTIAL', 'ANONYMOUS'] as const;
const STATUSES = ['DRAFT', 'OPEN', 'CLOSED'] as const;
const oneOf = <T extends readonly string[]>(values: T) => z.string().refine((v): v is T[number] => (values as readonly string[]).includes(v), 'not allowed');

export const createSurveySchema = z
  .object({
    key: z.string().regex(QUESTION_KEY_RE),
    templateKey: z.string().max(80).nullable().optional(),
    title: localized,
    intro: localized.nullable().optional(),
    audience: oneOf(AUDIENCES),
    anonymity: oneOf(ANONYMITIES),
    opensAt: z.string().datetime().nullable().optional(),
    closesAt: z.string().datetime().nullable().optional(),
    // Raised per survey, never below the default floor.
    minResponses: z.number().int().min(SURVEY_MIN_RESPONSES).max(1000).optional(),
    questions: questionsSchema,
  })
  .strict();

export const updateSurveySchema = z
  .object({
    title: localized.optional(),
    intro: localized.nullable().optional(),
    status: oneOf(STATUSES).optional(),
    opensAt: z.string().datetime().nullable().optional(),
    closesAt: z.string().datetime().nullable().optional(),
    minResponses: z.number().int().min(SURVEY_MIN_RESPONSES).max(1000).optional(),
    questions: questionsSchema.optional(),
  })
  .strict();

type QuestionInput = z.infer<typeof questionSchema>;

const questionRow = (q: QuestionInput, i: number) => ({
  key: q.key,
  type: q.type,
  labels: q.labels as Prisma.InputJsonValue,
  helpText: (q.helpText ?? undefined) as Prisma.InputJsonValue | undefined,
  options: (q.options ?? undefined) as Prisma.InputJsonValue | undefined,
  required: q.required ?? false,
  sortOrder: q.sortOrder ?? i,
});

const SURVEY_INCLUDE = { questions: { orderBy: { sortOrder: 'asc' as const } } } satisfies Prisma.SurveyInclude;

export async function createSurvey(orgId: string | null, input: z.infer<typeof createSurveySchema>) {
  return prisma.survey.create({
    data: {
      orgId,
      key: input.key,
      templateKey: input.templateKey ?? null,
      title: input.title,
      intro: (input.intro ?? undefined) as Prisma.InputJsonValue | undefined,
      audience: input.audience as SurveyAudience,
      anonymity: input.anonymity as SurveyAnonymity,
      opensAt: input.opensAt ? new Date(input.opensAt) : null,
      closesAt: input.closesAt ? new Date(input.closesAt) : null,
      minResponses: input.minResponses ?? SURVEY_MIN_RESPONSES,
      questions: { create: input.questions.map(questionRow) },
    },
    include: SURVEY_INCLUDE,
  });
}

/**
 * Edit a survey. In DRAFT the question list is replaced freely. Once it has
 * opened, the same keys with the same types must come back — wording, help
 * text, options and order may change; adding, removing, re-keying or
 * re-typing a question is a 409. Anonymity and audience are fixed at create:
 * changing who sees an answer after people answered would break the promise
 * they answered under, so this schema does not accept them at all.
 */
export async function updateSurvey(survey: { id: string; status: SurveyStatus }, patch: z.infer<typeof updateSurveySchema>) {
  if (patch.status === 'DRAFT' && survey.status !== 'DRAFT') throw new SurveyConflict('reopen_draft');
  return prisma.$transaction(async (tx) => {
    if (patch.questions) {
      if (survey.status === 'DRAFT') {
        await tx.surveyQuestion.deleteMany({ where: { surveyId: survey.id } });
        await tx.surveyQuestion.createMany({ data: patch.questions.map((q, i) => ({ surveyId: survey.id, ...questionRow(q, i) })) });
      } else {
        const existing = await tx.surveyQuestion.findMany({ where: { surveyId: survey.id }, select: { key: true, type: true } });
        const before = new Map(existing.map((q) => [q.key, q.type]));
        const sameShape =
          before.size === patch.questions.length && patch.questions.every((q) => before.get(q.key) === (q.type as SurveyQuestionType));
        if (!sameShape) throw new SurveyConflict('questions_locked');
        for (const [i, q] of patch.questions.entries()) {
          const row = questionRow(q, i);
          await tx.surveyQuestion.update({
            where: { surveyId_key: { surveyId: survey.id, key: q.key } },
            data: { labels: row.labels, helpText: row.helpText ?? Prisma.DbNull, options: row.options ?? Prisma.DbNull, required: row.required, sortOrder: row.sortOrder },
          });
        }
      }
    }
    return tx.survey.update({
      where: { id: survey.id },
      data: {
        ...(patch.title ? { title: patch.title } : {}),
        ...(patch.intro !== undefined ? { intro: patch.intro ?? Prisma.DbNull } : {}),
        ...(patch.status ? { status: patch.status as SurveyStatus } : {}),
        ...(patch.opensAt !== undefined ? { opensAt: patch.opensAt ? new Date(patch.opensAt) : null } : {}),
        ...(patch.closesAt !== undefined ? { closesAt: patch.closesAt ? new Date(patch.closesAt) : null } : {}),
        ...(patch.minResponses !== undefined ? { minResponses: patch.minResponses } : {}),
      },
      include: SURVEY_INCLUDE,
    });
  });
}

// ── Tokens ───────────────────────────────────────────────────────────────────

/** A fresh invitation token. Only its hash is stored. */
export function mintSurveyToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSurveyToken(token) };
}

export function hashSurveyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ── Responses ────────────────────────────────────────────────────────────────

export interface SubmitInput {
  surveyId: string;
  /** The invitation answered through, when there is one. */
  invitationId?: string | null;
  respondentId?: string | null;
  respondentRole: string;
  relationId?: string | null;
  answers: Record<string, unknown>;
}

/**
 * Record one response. The survey must be OPEN; every answer is validated
 * with the shared validator; an invitation can be answered once. For an
 * ANONYMOUS survey the respondent and the invitation are NOT written onto the
 * response — the invitation is stamped `respondedAt` in the same transaction
 * so completion tracking still works.
 */
export async function submitSurveyResponse(input: SubmitInput) {
  const survey = await prisma.survey.findUnique({
    where: { id: input.surveyId },
    select: { id: true, orgId: true, status: true, anonymity: true, questions: { select: { key: true, type: true, required: true, options: true } } },
  });
  if (!survey || survey.status !== 'OPEN') throw new SurveyConflict('not_open');

  const errors: Record<string, ValidationErrorKey | 'unknown_question'> = {};
  const known = new Map(survey.questions.map((q) => [q.key, q]));
  for (const key of Object.keys(input.answers)) if (!known.has(key)) errors[key] = 'unknown_question';
  for (const q of survey.questions) {
    if (!isSurveyQuestionType(q.type)) continue;
    const error = validateSurveyAnswer(
      { key: q.key, type: q.type, required: q.required, options: (q.options as { value: string; labels: Record<string, string> }[] | null) ?? null },
      input.answers[q.key],
    );
    if (error) errors[q.key] = error;
  }
  if (Object.keys(errors).length > 0) throw new SurveyAnswerInvalid(errors);

  const anonymous = survey.anonymity === 'ANONYMOUS';
  return prisma.$transaction(async (tx) => {
    if (input.invitationId) {
      // Claim the invitation first: a second submit finds it already stamped.
      const claimed = await tx.surveyInvitation.updateMany({
        where: { id: input.invitationId, surveyId: survey.id, respondedAt: null },
        data: { respondedAt: new Date() },
      });
      if (claimed.count === 0) throw new SurveyConflict('already_responded');
    }
    const answers = Object.entries(input.answers).filter(([, v]) => v !== undefined && v !== null && v !== '');
    return tx.surveyResponse.create({
      data: {
        orgId: survey.orgId,
        surveyId: survey.id,
        invitationId: anonymous ? null : (input.invitationId ?? null),
        respondentId: anonymous ? null : (input.respondentId ?? null),
        respondentRole: input.respondentRole,
        relationId: input.relationId ?? null,
        answers: {
          // Free text lives in `text` (a TEXT column, no JSON length games);
          // every other answer is its JSON value.
          create: answers.map(([questionKey, value]) =>
            known.get(questionKey)?.type === 'LONG_TEXT'
              ? { questionKey, value: Prisma.JsonNull, text: String(value) }
              : { questionKey, value: value as Prisma.InputJsonValue, text: null },
          ),
        },
      },
      select: { id: true, invitationId: true, respondentId: true },
    });
  });
}
