import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import {
  MAX_TEMPLATE_BODY,
  canonicalMessageText,
  normalizeMessageTranslations,
  serializeMessageTemplate,
} from '@/lib/messageTemplates';

// Management for the org-wide canned-response pool (#1871).
//
// The mirror of /api/admin/goal-templates, for messaging: list / add / edit /
// retire, in all three languages. Org-wide templates (`ownerId: null`) are
// offered to every writer in the tenant through /api/message-templates; a
// personal template belongs to its owner and is not managed from here.
//
// Retiring archives rather than deletes — see the DELETE handler.

const localeText = z.string().trim().max(MAX_TEMPLATE_BODY).optional();
const translationsSchema = z.object({ en: localeText, tr: localeText, de: localeText });

const createSchema = z.object({ translations: translationsSchema });
const updateSchema = z.object({ id: z.string().min(1), translations: translationsSchema });
const deleteSchema = z.object({ id: z.string().min(1) });

const rowSelect = {
  id: true,
  title: true,
  translations: true,
  useCount: true,
  ownerId: true,
} as const;

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return session;
}

// GET — the org-wide pool, most-used first.
export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const templates = await prisma.messageTemplate.findMany({
      where: { ownerId: null, archivedAt: null },
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select: rowSelect,
    });
    return NextResponse.json({ templates: templates.map(serializeMessageTemplate) });
  });
}

// POST — add an org-wide canned response. At least one language must be filled.
export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const translations = normalizeMessageTranslations(parsed.data.translations);
    const title = canonicalMessageText(translations);
    if (!title) return NextResponse.json({ error: 'Write the reply in at least one language' }, { status: 400 });

    // Dedupe by hand: `title` is a Text column with no unique index (see the
    // schema comment), and a nullable ownerId would defeat one in MySQL anyway.
    const existing = await prisma.messageTemplate.findFirst({
      where: { ownerId: null, title },
      select: { id: true, archivedAt: true },
    });
    if (existing?.archivedAt) {
      // Adding back a retired wording revives the original row, so its useCount
      // — the only record of how much the program leans on that reply — survives.
      const revived = await prisma.messageTemplate.update({
        where: { id: existing.id },
        data: { archivedAt: null, translations },
        select: rowSelect,
      });
      return NextResponse.json({ template: serializeMessageTemplate(revived) }, { status: 201 });
    }
    if (existing) return NextResponse.json({ error: 'That reply is already in the pool' }, { status: 409 });

    const template = await prisma.messageTemplate.create({
      data: { ownerId: null, title, translations, createdById: session.user.id },
      select: rowSelect,
    });
    return NextResponse.json({ template: serializeMessageTemplate(template) }, { status: 201 });
  });
}

// PATCH — rewrite an org-wide canned response in any/all languages.
export async function PATCH(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const target = await prisma.messageTemplate.findFirst({
      where: { id: parsed.data.id, ownerId: null, archivedAt: null },
      select: { id: true },
    });
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const translations = normalizeMessageTranslations(parsed.data.translations);
    const title = canonicalMessageText(translations);
    if (!title) return NextResponse.json({ error: 'Write the reply in at least one language' }, { status: 400 });

    const clash = await prisma.messageTemplate.findFirst({
      where: { ownerId: null, title, id: { not: target.id } },
      select: { id: true },
    });
    if (clash) return NextResponse.json({ error: 'That reply is already in the pool' }, { status: 409 });

    const template = await prisma.messageTemplate.update({
      where: { id: target.id },
      data: { title, translations },
      select: rowSelect,
    });
    return NextResponse.json({ template: serializeMessageTemplate(template) });
  });
}

// DELETE — retire an org-wide canned response. Archived, never removed: the row
// carries `useCount`, which is the only record of which wording a program
// actually relies on, and adding the same text back revives this row instead of
// starting a second one from zero. Messages already sent from it are unaffected
// either way — inserting a template copies its text into the composer.
export async function DELETE(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const archived = await prisma.messageTemplate.updateMany({
      where: { id: parsed.data.id, ownerId: null, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    if (archived.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
