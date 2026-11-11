import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { canonicalPrompt, normalizeAgendaTranslations, readAgendaTranslations } from '@/lib/agendasRule';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { tenantWhere, withinTenant } from '@/lib/tenantFilter';
import { resolveOrgId } from '@/lib/orgScope';
import { defaultOrgId } from '@/lib/defaultOrg';
import { requirePermission } from '@/lib/authz';

// The guide library's management surface (#1843): list / add / edit / retire
// the tenant's guided conversations (#1841), in all three languages, with
// their prompts. Mirrors /api/admin/goal-templates, including the one rule
// that matters most: DELETE archives, never removes — a SessionAgenda holds a
// live reference to the template and its lines read their wording from the
// template's items, so taking the row away would blank a held session.
//
// "The tenant's" means ONE tenant (cross-world isolation): each org has its
// own library keyed by `orgId`; a legacy NULL row is the default org's
// (src/lib/tenantFilter.ts).

const MAX_ITEMS = 30;

// AgendaTemplate.title and AgendaTemplateItem.prompt are VARCHAR(191) — the
// same bound as a to-do title (#1433: a wider cap is a P2000 in the driver).
const localeText = z.string().trim().max(TEXT_LIMITS.todoTitle).optional();
const localeSummary = z.string().trim().max(TEXT_LIMITS.agendaSummary).optional();
const translationsSchema = z.object({ en: localeText, tr: localeText, de: localeText });
const summarySchema = z.object({ en: localeSummary, tr: localeSummary, de: localeSummary });
const itemSchema = z.object({
  id: z.string().min(1).optional(),
  translations: translationsSchema,
  guidance: z.string().trim().max(TEXT_LIMITS.agendaGuidance).optional(),
});

const createSchema = z.object({
  translations: translationsSchema,
  summary: summarySchema.optional(),
  items: z.array(itemSchema).min(1).max(MAX_ITEMS),
});
const updateSchema = z.object({
  id: z.string().min(1),
  translations: translationsSchema.optional(),
  summary: summarySchema.optional(),
  items: z.array(itemSchema).min(1).max(MAX_ITEMS).optional(),
});
const deleteSchema = z.object({ id: z.string().min(1) });

const select = {
  id: true,
  title: true,
  translations: true,
  summary: true,
  useCount: true,
  archivedAt: true,
  items: { orderBy: { order: 'asc' as const }, select: { id: true, order: true, prompt: true, translations: true, guidance: true } },
} as const;

type Row = {
  id: string;
  title: string;
  translations: unknown;
  summary: unknown;
  useCount: number;
  archivedAt: Date | null;
  items: { id: string; order: number; prompt: string; translations: unknown; guidance: string | null }[];
};

function serialize(t: Row) {
  return {
    id: t.id,
    title: t.title,
    translations: readAgendaTranslations(t.translations),
    summary: readAgendaTranslations(t.summary),
    useCount: t.useCount,
    archived: t.archivedAt !== null,
    items: t.items.map((i) => ({
      id: i.id,
      order: i.order,
      prompt: i.prompt,
      translations: readAgendaTranslations(i.translations),
      guidance: i.guidance,
    })),
  };
}


type ItemInput = z.infer<typeof itemSchema>;

/** The stored shape of one prompt, or null when no language was filled in. */
function itemData(item: ItemInput, order: number) {
  const translations = normalizeAgendaTranslations(item.translations);
  const prompt = canonicalPrompt(translations);
  if (!prompt) return null;
  return { order, prompt, translations, guidance: item.guidance?.trim() || null };
}

/**
 * Bring a template's prompts in line with the payload: rows whose id is sent
 * are reworded and reordered in place (a held session keeps following them),
 * new ones are created, and rows the payload no longer lists are removed —
 * their `SessionAgendaItem.templateItemId` becomes NULL (schema: SetNull)
 * and the line falls back to the snapshot text it was given, so nothing a pair
 * already holds goes blank.
 */
async function syncItems(templateId: string, items: ItemInput[]) {
  const existing = await prisma.agendaTemplateItem.findMany({ where: { templateId }, select: { id: true } });
  const known = new Set(existing.map((i) => i.id));
  const keep = new Set<string>();
  let order = 0;
  for (const item of items) {
    const data = itemData(item, order);
    if (!data) continue;
    if (item.id && known.has(item.id)) {
      await prisma.agendaTemplateItem.update({ where: { id: item.id }, data });
      keep.add(item.id);
    } else {
      const created = await prisma.agendaTemplateItem.create({ data: { ...data, templateId }, select: { id: true } });
      keep.add(created.id);
    }
    order += 1;
  }
  const gone = existing.filter((i) => !keep.has(i.id)).map((i) => i.id);
  if (gone.length > 0) await prisma.agendaTemplateItem.deleteMany({ where: { id: { in: gone } } });
  return order;
}

// GET — the live library, most-used first, with prompts.
export async function GET(request: Request) {
  const gate = await requirePermission('content.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  // Internship-only surface: closed for an org without mentorship (#2647).
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
    const templates = await prisma.agendaTemplate.findMany({
      where: withinTenant({ archivedAt: null }, await tenantWhere(session)),
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select,
    });
    return NextResponse.json({ templates: templates.map(serialize) });
  });
}

// POST — add a guide. At least one language of the title and one prompt.
export async function POST(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const translations = normalizeAgendaTranslations(parsed.data.translations);
    const title = canonicalPrompt(translations);
    if (!title) return NextResponse.json({ error: 'Write the title in at least one language', code: 'title_required' }, { status: 400 });
    const summary = normalizeAgendaTranslations(parsed.data.summary ?? {}, TEXT_LIMITS.agendaSummary);
    if (!parsed.data.items.some((item, i) => itemData(item, i))) {
      return NextResponse.json({ error: 'Write at least one prompt', code: 'items_required' }, { status: 400 });
    }

    // MySQL does not enforce @@unique([orgId, title]) across NULL orgIds, so the
    // same wording twice is caught by hand.
    const tenant = await tenantWhere(session);
    const existing = await prisma.agendaTemplate.findFirst({
      where: withinTenant({ title }, tenant),
      select: { id: true, archivedAt: true },
    });
    if (existing?.archivedAt) {
      // Adding back a retired wording revives the original row, so the sessions
      // held from it stay attached to it.
      await prisma.agendaTemplate.update({
        where: { id: existing.id },
        data: { archivedAt: null, translations, summary },
      });
      await syncItems(existing.id, parsed.data.items);
      const revived = await prisma.agendaTemplate.findUniqueOrThrow({ where: { id: existing.id }, select });
      return NextResponse.json({ template: serialize(revived) }, { status: 201 });
    }
    if (existing) return NextResponse.json({ error: 'That guide is already in the library', code: 'duplicate' }, { status: 409 });

    const created = await prisma.agendaTemplate.create({
      data: {
        orgId: resolveOrgId(session) ?? (await defaultOrgId()),
        title,
        translations,
        summary,
        createdById: session.user.id,
        items: {
          create: parsed.data.items
            .map((item, i) => itemData(item, i))
            .filter((d): d is NonNullable<typeof d> => d !== null)
            .map((d, order) => ({ ...d, order })),
        },
      },
      select,
    });
    return NextResponse.json({ template: serialize(created) }, { status: 201 });
  });
}

// PATCH — reword a guide, its summary and/or its prompts.
export async function PATCH(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const tenant = await tenantWhere(session);
    // Another tenant's guide answers like a missing one.
    const target = await prisma.agendaTemplate.findFirst({
      where: withinTenant({ id: parsed.data.id, archivedAt: null }, tenant),
      select: { id: true },
    });
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const data: { title?: string; translations?: ReturnType<typeof normalizeAgendaTranslations>; summary?: ReturnType<typeof normalizeAgendaTranslations> } = {};
    if (parsed.data.translations) {
      const translations = normalizeAgendaTranslations(parsed.data.translations);
      const title = canonicalPrompt(translations);
      if (!title) return NextResponse.json({ error: 'Write the title in at least one language', code: 'title_required' }, { status: 400 });
      const clash = await prisma.agendaTemplate.findFirst({
        where: withinTenant({ title, id: { not: target.id } }, tenant),
        select: { id: true },
      });
      if (clash) return NextResponse.json({ error: 'That guide is already in the library', code: 'duplicate' }, { status: 409 });
      data.title = title;
      data.translations = translations;
    }
    if (parsed.data.summary) data.summary = normalizeAgendaTranslations(parsed.data.summary, TEXT_LIMITS.agendaSummary);
    if (parsed.data.items && !parsed.data.items.some((item, i) => itemData(item, i))) {
      return NextResponse.json({ error: 'Write at least one prompt', code: 'items_required' }, { status: 400 });
    }

    if (Object.keys(data).length > 0) await prisma.agendaTemplate.update({ where: { id: target.id }, data });
    if (parsed.data.items) await syncItems(target.id, parsed.data.items);
    const template = await prisma.agendaTemplate.findUniqueOrThrow({ where: { id: target.id }, select });
    return NextResponse.json({ template: serialize(template) });
  });
}

// DELETE — retire a guide. Archived, not removed (#1113): the sessions held
// from it keep reading their prompts here, in each person's language.
export async function DELETE(request: Request) {
  const gate = await requirePermission('content.write', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const capabilityRefusal = await requireCapability(session.user.orgId, 'mentorship');
  if (capabilityRefusal) return capabilityRefusal;
  return await withTenantScope(session, async () => {
    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const archived = await prisma.agendaTemplate.updateMany({
      where: withinTenant({ id: parsed.data.id, archivedAt: null }, await tenantWhere(session)),
      data: { archivedAt: new Date() },
    });
    if (archived.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
