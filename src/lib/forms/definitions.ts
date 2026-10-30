// The admin-form write boundary (#1800): creating, editing, publishing and
// archiving a form definition, and recording a person's answers. Every rule
// that protects an answer is enforced HERE, at the write — the routes only
// translate a FormWriteError into its status. The rules themselves are pure in
// src/lib/forms/definitionRule.ts; the one answer validator is
// validateResponse() in src/lib/forms/schema.ts. docs/forms.md is the design.

import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isFormFieldType, validateResponse, type FormFieldDef, type FormFieldType, type ValidationErrorKey } from '@/lib/forms/schema';
import {
  FORM_AUDIENCES,
  FORM_KEY_RE,
  FORM_SURFACES,
  MAX_FORM_FIELDS,
  checkFieldEdit,
  editTarget,
  latestAnswersByKey,
  liveVersion,
  type FormEditCode,
} from '@/lib/forms/definitionRule';
import { missingLocales, type BuilderField } from '@/lib/forms/builderRule';

/** A write the rules refuse — `status` is what the route answers. */
export class FormWriteError extends Error {
  constructor(
    public code: FormEditCode | 'draft_exists' | 'not_latest' | 'already_published' | 'not_published' | 'invalid_answers' | 'missing_locales',
    public status: 400 | 409,
    public detail?: Record<string, unknown>,
  ) {
    super(code);
  }
}

const localized = z
  .object({ en: z.string().trim().max(500).optional(), tr: z.string().trim().max(500).optional(), de: z.string().trim().max(500).optional() })
  .strict()
  .refine((v) => !!(v.en || v.tr || v.de), 'at least one language');

const optionSchema = z.object({ value: z.string().trim().min(1).max(80), labels: localized }).strict();
const oneOf = <T extends readonly string[]>(values: T) => z.string().refine((v): v is T[number] => (values as readonly string[]).includes(v), 'not allowed');

export const fieldInputSchema = z
  .object({
    id: z.string().max(40).nullable().optional(),
    key: z.string().regex(FORM_KEY_RE),
    type: z.string().refine(isFormFieldType, 'unknown type'),
    labels: localized,
    helpText: localized.nullable().optional(),
    options: z.array(optionSchema).max(50).nullable().optional(),
    required: z.boolean().optional(),
    matchable: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((f) => (f.type === 'SELECT' || f.type === 'MULTI_SELECT' ? (f.options?.length ?? 0) > 0 : true), 'choice fields need options');

export const createFormSchema = z
  .object({
    key: z.string().regex(FORM_KEY_RE),
    audience: oneOf(FORM_AUDIENCES),
    surface: oneOf(FORM_SURFACES),
    title: localized.nullable().optional(),
    fields: z.array(fieldInputSchema).max(MAX_FORM_FIELDS),
  })
  .strict();

export const updateFormSchema = z
  .object({
    title: localized.nullable().optional(),
    fields: z.array(fieldInputSchema).max(MAX_FORM_FIELDS),
  })
  .strict();

type FieldInput = Omit<z.infer<typeof fieldInputSchema>, 'type'> & { type: string };

const FORM_INCLUDE = { fields: { orderBy: { sortOrder: 'asc' as const } } } satisfies Prisma.FormDefinitionInclude;
export type FormWithFields = Prisma.FormDefinitionGetPayload<{ include: typeof FORM_INCLUDE }>;

const fieldRow = (f: FieldInput, i: number) => ({
  key: f.key,
  type: f.type,
  labels: f.labels as Prisma.InputJsonValue,
  helpText: (f.helpText ?? undefined) as Prisma.InputJsonValue | undefined,
  options: (f.type === 'SELECT' || f.type === 'MULTI_SELECT' ? f.options ?? undefined : undefined) as Prisma.InputJsonValue | undefined,
  required: f.required ?? false,
  matchable: f.matchable ?? false,
  sortOrder: i,
  archivedAt: f.archived ? new Date() : null,
});

type Tx = Prisma.TransactionClient;

/** key → type of every field of every published version of this form. */
async function lockedTypes(tx: Tx, orgId: string | null, key: string): Promise<Map<string, string>> {
  const rows = await tx.formField.findMany({
    where: { definition: { orgId, key, publishedAt: { not: null } } },
    select: { key: true, type: true },
  });
  return new Map(rows.map((r) => [r.key, r.type]));
}

function refuseEdit(fields: readonly FieldInput[], locked: Map<string, string>, current: Map<string, { key: string; type: string }>) {
  const refusal = checkFieldEdit(fields, locked, current);
  if (refusal) throw new FormWriteError(refusal.code, refusal.code === 'not_matchable' || refusal.code === 'duplicate_key' || refusal.code === 'invalid_type' ? 400 : 409, { key: refusal.key });
}

/** Create version 1 of a form, as a draft. A key already in use is a 409. */
export async function createFormDefinition(orgId: string | null, input: z.infer<typeof createFormSchema>): Promise<FormWithFields> {
  refuseEdit(input.fields, new Map(), new Map());
  try {
    return await prisma.formDefinition.create({
      data: {
        orgId,
        key: input.key,
        audience: input.audience,
        surface: input.surface,
        version: 1,
        title: (input.title ?? undefined) as Prisma.InputJsonValue | undefined,
        fields: { create: input.fields.map(fieldRow) },
      },
      include: FORM_INCLUDE,
    });
  } catch (error) {
    if ((error as { code?: string })?.code === 'P2002') throw new FormWriteError('draft_exists', 409);
    throw error;
  }
}

/**
 * Save an edit of `definitionId`. A draft is rewritten in place; a published
 * version stays exactly as it is and the edit becomes version N+1 (a draft).
 * Fields of the source left out of the edit are carried over ARCHIVED, so the
 * new version still describes the answers given to them.
 */
export async function saveFormDefinition(definitionId: string, input: z.infer<typeof updateFormSchema>): Promise<{ form: FormWithFields; newVersion: boolean }> {
  return prisma.$transaction(async (tx) => {
    const source = await tx.formDefinition.findUniqueOrThrow({ where: { id: definitionId }, include: FORM_INCLUDE });
    const latest = await tx.formDefinition.aggregate({ where: { orgId: source.orgId, key: source.key }, _max: { version: true } });
    const latestVersion = latest._max.version ?? source.version;
    if (source.version !== latestVersion) {
      // Only the newest version is edited; an edit of an older one would fork the form.
      const newer = await tx.formDefinition.findFirst({ where: { orgId: source.orgId, key: source.key, version: latestVersion }, select: { id: true, publishedAt: true } });
      throw new FormWriteError(newer && !newer.publishedAt ? 'draft_exists' : 'not_latest', 409, { latestId: newer?.id });
    }
    const current = new Map(source.fields.map((f) => [f.id, { key: f.key, type: f.type }]));
    refuseEdit(input.fields, await lockedTypes(tx, source.orgId, source.key), current);

    const kept = new Set(input.fields.map((f) => f.key));
    const carried: FieldInput[] = source.fields
      .filter((f) => !kept.has(f.key))
      .map((f) => ({
        key: f.key,
        type: f.type,
        labels: f.labels as z.infer<typeof localized>,
        helpText: (f.helpText ?? null) as z.infer<typeof localized> | null,
        options: (f.options ?? null) as FieldInput['options'],
        required: false,
        matchable: f.matchable,
        archived: true,
      }));
    const rows = [...input.fields, ...carried].map(fieldRow).map((r, i) => {
      // An archived field keeps its own archive date when it already had one.
      const prior = source.fields.find((f) => f.key === r.key);
      return r.archivedAt && prior?.archivedAt ? { ...r, archivedAt: prior.archivedAt, sortOrder: i } : r;
    });
    const title = input.title === undefined ? undefined : (input.title ?? Prisma.DbNull);

    const target = editTarget(source, latestVersion);
    if (target.inPlace) {
      await tx.formField.deleteMany({ where: { definitionId: source.id } });
      await tx.formField.createMany({ data: rows.map((r) => ({ ...r, definitionId: source.id })) });
      const form = await tx.formDefinition.update({ where: { id: source.id }, data: { ...(title !== undefined ? { title } : {}) }, include: FORM_INCLUDE });
      return { form, newVersion: false };
    }
    const form = await tx.formDefinition.create({
      data: {
        orgId: source.orgId,
        key: source.key,
        audience: source.audience,
        surface: source.surface,
        version: target.version,
        title: (title === undefined ? source.title ?? undefined : title) as Prisma.InputJsonValue | typeof Prisma.DbNull | undefined,
        fields: { create: rows },
      },
      include: FORM_INCLUDE,
    });
    return { form, newVersion: true };
  });
}

/**
 * Publish a draft. It becomes the form's live version and every older
 * published version of the same key is archived — one live version at a time.
 */
export async function publishFormDefinition(definitionId: string, now = new Date()): Promise<FormWithFields> {
  return prisma.$transaction(async (tx) => {
    const def = await tx.formDefinition.findUniqueOrThrow({
      where: { id: definitionId },
      select: { id: true, orgId: true, key: true, version: true, publishedAt: true, fields: { select: { key: true, type: true, labels: true, helpText: true, options: true, archivedAt: true } } },
    });
    if (def.publishedAt) throw new FormWriteError('already_published', 409);
    // A live field reads in every language the product speaks (#1802): a TR
    // participant must never meet an empty question. The builder shows the
    // same list before the button is pressed (missingLocales, builderRule.ts).
    const missing = missingLocales(def.fields as unknown as BuilderField[]);
    if (missing.length > 0) throw new FormWriteError('missing_locales', 400, { fields: missing });
    const claimed = await tx.formDefinition.updateMany({ where: { id: def.id, publishedAt: null }, data: { publishedAt: now, archivedAt: null } });
    if (claimed.count !== 1) throw new FormWriteError('already_published', 409);
    await tx.formDefinition.updateMany({
      where: { orgId: def.orgId, key: def.key, version: { lt: def.version }, publishedAt: { not: null }, archivedAt: null },
      data: { archivedAt: now },
    });
    return tx.formDefinition.findUniqueOrThrow({ where: { id: def.id }, include: FORM_INCLUDE });
  });
}

/** Retire a form: its live version stops being asked. Answers stay. */
export async function archiveFormDefinition(definitionId: string, now = new Date()): Promise<void> {
  const def = await prisma.formDefinition.findUniqueOrThrow({ where: { id: definitionId }, select: { orgId: true, key: true } });
  await prisma.formDefinition.updateMany({ where: { orgId: def.orgId, key: def.key, archivedAt: null }, data: { archivedAt: now } });
}

/** The live version of a form key, or null. */
export async function liveFormDefinition(orgId: string | null, key: string): Promise<FormWithFields | null> {
  const versions = await prisma.formDefinition.findMany({ where: { orgId, key, publishedAt: { not: null }, archivedAt: null }, include: FORM_INCLUDE });
  return liveVersion(versions);
}

/** The field as validateResponse() reads it. */
export function fieldDef(f: { key: string; type: string; required: boolean; options: unknown }): FormFieldDef {
  return { key: f.key, type: f.type as FormFieldType, required: f.required, options: Array.isArray(f.options) ? (f.options as FormFieldDef['options']) : null };
}

/**
 * Record `userId`'s answers to the live, non-archived fields of `definition`.
 * Every value goes through validateResponse() — the same function the browser
 * ran. An unknown key, or a required field left empty, refuses the whole save.
 */
export async function saveFormResponses(
  userId: string,
  definition: FormWithFields,
  answers: Record<string, unknown>,
): Promise<void> {
  const active = definition.fields.filter((f) => !f.archivedAt);
  const errors: Record<string, ValidationErrorKey | 'unknown_field'> = {};
  for (const key of Object.keys(answers)) if (!active.some((f) => f.key === key)) errors[key] = 'unknown_field';
  for (const f of active) {
    const err = validateResponse(fieldDef(f), answers[f.key]);
    if (err) errors[f.key] = err;
  }
  if (Object.keys(errors).length > 0) throw new FormWriteError('invalid_answers', 400, { errors });
  await prisma.$transaction(
    active
      .filter((f) => answers[f.key] !== undefined && answers[f.key] !== null)
      .map((f) =>
        prisma.formResponse.upsert({
          where: { userId_definitionId_fieldKey: { userId, definitionId: definition.id, fieldKey: f.key } },
          create: { orgId: definition.orgId, userId, definitionId: definition.id, fieldKey: f.key, value: answers[f.key] as Prisma.InputJsonValue },
          update: { value: answers[f.key] as Prisma.InputJsonValue },
        }),
      ),
  );
}

/**
 * A person's latest answer per field key across EVERY version of a form —
 * archived fields and superseded versions included, so nothing an answer was
 * given to stops resolving.
 */
export async function latestFormAnswers(userId: string, orgId: string | null, key: string): Promise<Map<string, unknown>> {
  const rows = await prisma.formResponse.findMany({
    where: { userId, definition: { orgId, key } },
    select: { fieldKey: true, value: true, updatedAt: true },
  });
  return new Map([...latestAnswersByKey(rows)].map(([k, r]) => [k, r.value]));
}
