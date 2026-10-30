// Answers given on a PUBLIC form, before the person has an account (#1803):
// the per-mentor apply link (`/api/apply`) and the become-a-mentor application
// (`/api/mentor-applications`). Server-only.
//
//   · The org comes from the link, never from a session (there is none): the
//     mentor's org for an apply link, the default org for a mentor application.
//   · Every live REGISTRATION form for the role is checked with the SAME
//     validateResponse() the signed-in surfaces use — required questions
//     included — BEFORE anything is created, so a refused answer never leaves
//     a half-made account behind.
//   · Where the account is created on the spot (apply), the answers are
//     written onto it straight away. Where it is not (a mentor application
//     waits for an admin), they are STAGED on the application row and carried
//     onto the account when it appears — then cleared from the application.

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { defaultOrgId } from '@/lib/defaultOrg';
import { activeForms } from '@/lib/forms/active';
import { fieldDef, FormWriteError, saveFormResponses, type FormWithFields } from '@/lib/forms/definitions';
import { validateResponse, type ValidationErrorKey } from '@/lib/forms/schema';

/** The shape a public form posts its answers in. Absent = the client asked nothing. */
export const publicAnswersSchema = z
  .array(z.object({ definitionId: z.string().min(1).max(40), answers: z.record(z.string().max(80), z.unknown()) }).strict())
  .max(10)
  .optional();

export type StagedAnswers = { definitionId: string; answers: Record<string, unknown> }[];

export type PublicAnswerCheck =
  | { ok: true; staged: StagedAnswers }
  | { ok: false; errors: Record<string, Record<string, ValidationErrorKey | 'unknown_field'>> | { form: 'unknown_form' } };

const empty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** Check `submitted` against every live REGISTRATION form `role` is asked in `orgId`. */
export async function checkPublicAnswers(orgId: string | null, role: 'MENTEE' | 'MENTOR', submitted: StagedAnswers | undefined): Promise<PublicAnswerCheck> {
  const forms = await activeForms(orgId, 'REGISTRATION', role);
  const byId = new Map((submitted ?? []).map((s) => [s.definitionId, s.answers]));
  // An answer to a form this link does not ask is refused, not dropped.
  for (const id of byId.keys()) if (!forms.some((f) => f.id === id)) return { ok: false, errors: { form: 'unknown_form' } };
  const errors: Record<string, Record<string, ValidationErrorKey | 'unknown_field'>> = {};
  const staged: StagedAnswers = [];
  for (const form of forms) {
    const answers = byId.get(form.id) ?? {};
    const live = form.fields.filter((f) => !f.archivedAt);
    const formErrors: Record<string, ValidationErrorKey | 'unknown_field'> = {};
    for (const key of Object.keys(answers)) if (!live.some((f) => f.key === key)) formErrors[key] = 'unknown_field';
    for (const f of live) {
      const err = validateResponse(fieldDef(f), answers[f.key]);
      if (err) formErrors[f.key] = err;
    }
    if (Object.keys(formErrors).length > 0) errors[form.key] = formErrors;
    const kept = Object.fromEntries(live.filter((f) => !empty(answers[f.key])).map((f) => [f.key, answers[f.key]]));
    if (Object.keys(kept).length > 0) staged.push({ definitionId: form.id, answers: kept });
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, staged };
}

/**
 * Write staged answers onto `userId`. Each definition is re-read and the
 * answers re-validated by saveFormResponses(); a definition that is gone, or
 * answers that no longer validate, are skipped and logged — the account
 * creation they ride on must never fail over a questionnaire.
 */
export async function writeStagedAnswers(userId: string, staged: unknown): Promise<number> {
  const parsed = z.array(z.object({ definitionId: z.string(), answers: z.record(z.unknown()) })).safeParse(staged);
  if (!parsed.success) return 0;
  let written = 0;
  for (const { definitionId, answers } of parsed.data) {
    const definition: FormWithFields | null = await prisma.formDefinition.findUnique({ where: { id: definitionId }, include: { fields: { orderBy: { sortOrder: 'asc' } } } });
    if (!definition) continue;
    // Only the questions that were answered: a required field the form
    // gained since must not refuse the carry-over of the ones that were.
    const asked = { ...definition, fields: definition.fields.filter((f) => !f.archivedAt && f.key in answers).map((f) => ({ ...f, required: false })) };
    try {
      await saveFormResponses(userId, asked, answers);
      written++;
    } catch (error) {
      if (!(error instanceof FormWriteError)) throw error;
      console.error('Staged form answers skipped:', definitionId, error.code);
    }
  }
  return written;
}

/**
 * Carry a mentor application's staged answers onto the mentor account it
 * produced — on approval (an existing account promoted) or at registration
 * (the invitation it sent). The newest APPROVED application with the
 * account's address in the account's org wins; its staged answers are then
 * cleared, so they live in one place only.
 */
export async function carryMentorApplicationAnswers(user: { id: string; email: string; orgId: string | null }): Promise<void> {
  const fallback = await defaultOrgId();
  const org = user.orgId ?? fallback;
  const application = await prisma.mentorApplication.findFirst({
    where: {
      email: user.email.toLowerCase(),
      status: 'APPROVED',
      NOT: { formAnswers: { equals: Prisma.DbNull } },
      ...(org === fallback ? { OR: [{ orgId: org }, { orgId: null }] } : { orgId: org }),
    },
    orderBy: { decidedAt: 'desc' },
    select: { id: true, formAnswers: true },
  });
  if (!application) return;
  await writeStagedAnswers(user.id, application.formAnswers);
  await prisma.mentorApplication.update({ where: { id: application.id }, data: { formAnswers: Prisma.DbNull } });
}
