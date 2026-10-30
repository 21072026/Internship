// Which admin-defined forms a person is asked on a surface (#1803), and the
// read/write of their OWN answers. Server-only. The definitions themselves
// are written by ./definitions.ts; the one answer validator is
// validateResponse() in ./schema.ts, run by saveFormResponses() at the write.
//
// Two rules are load-bearing here:
//   · A participant only ever sees the LIVE version of a form whose audience
//     covers their role (MENTEE / MENTOR, plus BOTH). Any other role is asked
//     nothing — no admin, company or source account has a questionnaire.
//   · The person an answer belongs to is never a parameter a route can take
//     from a request: every function here is called with the session's user.

import { prisma } from '@/lib/prisma';
import { liveVersion, type FormAudience, type FormSurface } from '@/lib/forms/definitionRule';
import { latestFormAnswers, type FormWithFields } from '@/lib/forms/definitions';
import type { FormFieldType, LocalizedText } from '@/lib/forms/schema';

/** The audiences a role answers. Empty for every role that is never asked. */
export function audiencesFor(role: string | null | undefined): FormAudience[] {
  if (role === 'MENTEE') return ['MENTEE', 'BOTH'];
  if (role === 'MENTOR') return ['MENTOR', 'BOTH'];
  return [];
}

/** The live forms of `surface` for `role` in `orgId`, one per form key, ordered by key. */
export async function activeForms(orgId: string | null, surface: FormSurface, role: string | null | undefined): Promise<FormWithFields[]> {
  const audiences = audiencesFor(role);
  if (audiences.length === 0) return [];
  const versions = await prisma.formDefinition.findMany({
    where: { orgId, surface, audience: { in: audiences }, publishedAt: { not: null }, archivedAt: null },
    include: { fields: { orderBy: { sortOrder: 'asc' } } },
  });
  const byKey = new Map<string, FormWithFields[]>();
  for (const v of versions) byKey.set(v.key, [...(byKey.get(v.key) ?? []), v]);
  return [...byKey.keys()]
    .sort()
    .map((key) => liveVersion(byKey.get(key)!))
    .filter((f): f is FormWithFields => !!f);
}

/** What a participant's screen receives: the questions, never `matchable` or any answer. */
export interface PublicForm {
  id: string;
  key: string;
  version: number;
  title: LocalizedText | null;
  fields: { key: string; type: FormFieldType; labels: LocalizedText; helpText: LocalizedText | null; options: { value: string; labels: LocalizedText }[] | null; required: boolean }[];
}

export function publicForm(form: FormWithFields): PublicForm {
  return {
    id: form.id,
    key: form.key,
    version: form.version,
    title: (form.title ?? null) as LocalizedText | null,
    fields: form.fields
      .filter((f) => !f.archivedAt)
      .map((f) => ({
        key: f.key,
        type: f.type as FormFieldType,
        labels: f.labels as LocalizedText,
        helpText: (f.helpText ?? null) as LocalizedText | null,
        options: Array.isArray(f.options) ? (f.options as unknown as PublicForm['fields'][number]['options']) : null,
        required: f.required,
      })),
  };
}

/** `userId`'s own latest answers to each form, keyed by form key then field key. */
export async function ownAnswers(userId: string, forms: readonly FormWithFields[]): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const form of forms) {
    const live = new Set(form.fields.filter((f) => !f.archivedAt).map((f) => f.key));
    const answers = await latestFormAnswers(userId, form.orgId, form.key);
    out[form.key] = Object.fromEntries([...answers].filter(([k]) => live.has(k)));
  }
  return out;
}
