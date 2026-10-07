import { defaultLocale, type Locale } from '@/i18n/config';
import { prisma } from '@/lib/prisma';

// Session agendas (#1841): the trilingual resolver for the guided-conversation
// library (AgendaTemplate / AgendaTemplateItem) and the per-session instance
// (SessionAgenda / SessionAgendaItem).
//
// Mirrors src/lib/goalTemplates.ts line for line, and for the same reason: a
// template is one conversation written in up to three languages. The canonical
// string (`title` on a template, `prompt` on an item) is the dedupe key and the
// fallback when the reader's language has no entry; `translations` carries the
// per-locale text. An item of a TEMPLATED session agenda keeps a reference to
// its template item and resolves its wording on every render in the reader's
// language (exactly like resolveTaskTitle) — rewording the library reaches
// every session that was given it. An ad-hoc item stores its own string.
//
// The pure helpers here have no Prisma dependency; only `instantiateAgenda` at
// the bottom touches the database — they live in src/lib/agendasRule.ts and are
// re-exported here; `scripts/test/agendas.test.mjs` imports that file so it
// runs with no build step and no DB.

export {
  type AgendaTranslations,
  normalizeAgendaTranslations,
  readAgendaTranslations,
  canonicalPrompt,
  resolveTemplateText,
  resolveItemText,
  type AgendaItemTextSource,
} from '@/lib/agendasRule';

import { readAgendaTranslations, resolveTemplateText } from '@/lib/agendasRule';

/** What a session item's template half needs from the DB — the client resolves the wording. */
export const agendaTemplateItemSelect = {
  select: { id: true, prompt: true, translations: true, guidance: true, order: true },
} as const;

/** The client-facing shape of a template (title + summary in every language it has). */
export function serializeAgendaTemplate(
  template: {
    id: string;
    title: string;
    translations: unknown;
    summary: unknown;
    audience: string;
    useCount: number;
    archivedAt: Date | null;
  },
  language: string | null | undefined
) {
  return {
    id: template.id,
    title: resolveTemplateText({ text: template.title, translations: template.translations }, language),
    translations: readAgendaTranslations(template.translations),
    summary: resolveTemplateText({ text: '', translations: template.summary }, language) || null,
    audience: template.audience,
    useCount: template.useCount,
    archived: template.archivedAt !== null,
  };
}

export interface InstantiateAgendaInput {
  relationId: string;
  templateId: string;
  /** The session this agenda is for; null when the meeting is not scheduled yet. */
  meetingId?: string | null;
  createdById?: string | null;
}

/**
 * Create a SessionAgenda from a template: one SessionAgendaItem per template
 * item, in order, each pointing back at its template item so its text resolves
 * live. `text` is filled with the template's wording in `locale` as the
 * snapshot FALLBACK only — the reader never sees it while the template item
 * exists. Bumps the template's `useCount`, like handing out a to-do template.
 *
 * Returns null when the template does not exist or is archived — a retired
 * conversation is not offered again (#1113), though sessions already held from
 * it keep resolving.
 */
export async function instantiateAgenda(input: InstantiateAgendaInput, locale: Locale = defaultLocale) {
  const template = await prisma.agendaTemplate.findUnique({
    where: { id: input.templateId },
    include: { items: { orderBy: { order: 'asc' } } },
  });
  if (!template || template.archivedAt) return null;

  const [agenda] = await prisma.$transaction([
    prisma.sessionAgenda.create({
      data: {
        relationId: input.relationId,
        meetingId: input.meetingId ?? null,
        templateId: template.id,
        createdById: input.createdById ?? null,
        items: {
          create: template.items.map((item, index) => ({
            order: index,
            templateItemId: item.id,
            text: resolveTemplateText({ text: item.prompt, translations: item.translations }, locale),
          })),
        },
      },
      include: { items: { orderBy: { order: 'asc' }, include: { templateItem: agendaTemplateItemSelect } } },
    }),
    prisma.agendaTemplate.update({ where: { id: template.id }, data: { useCount: { increment: 1 } } }),
  ]);
  return agenda;
}
