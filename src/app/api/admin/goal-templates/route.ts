import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { canonicalTitle, normalizeTranslations, readTranslations } from '@/lib/goalTemplates';

// The shared goal-template pool (#51 follow-up).
//
// Every project's pool is "its own templates + the shared ones", and the shared
// half is what a mentor reaches for on day one. It used to be writable only by
// the seeder, so a wording nobody liked was stuck. This is its management
// surface: list / add / edit / delete, in all three languages.
//
// Shared templates are `projectId: null`. A project's own templates are managed
// by whoever leads that project, through
// /api/projects/[id]/task-templates — not here.

const localeText = z.string().trim().max(300).optional();
const translationsSchema = z.object({ en: localeText, tr: localeText, de: localeText });

const createSchema = z.object({ translations: translationsSchema });
const updateSchema = z.object({ id: z.string().min(1), translations: translationsSchema });
const deleteSchema = z.object({ id: z.string().min(1) });

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return null;
  return session;
}

function serialize(t: { id: string; title: string; translations: unknown; useCount: number }) {
  return { id: t.id, title: t.title, translations: readTranslations(t.translations), useCount: t.useCount };
}

// GET — the shared pool, most-used first.
export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const templates = await prisma.projectTaskTemplate.findMany({
      where: { projectId: null },
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, translations: true, useCount: true },
    });
    return NextResponse.json({ templates: templates.map(serialize) });
  });
}

// POST — add a shared template. At least one language must be filled in.
export async function POST(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const translations = normalizeTranslations(parsed.data.translations);
    const title = canonicalTitle(translations);
    if (!title) return NextResponse.json({ error: 'Write the goal in at least one language' }, { status: 400 });

    // MySQL does not enforce @@unique([projectId, title]) across NULL
    // projectIds, so the same wording twice has to be caught by hand.
    const existing = await prisma.projectTaskTemplate.findFirst({
      where: { projectId: null, title },
      select: { id: true },
    });
    if (existing) return NextResponse.json({ error: 'That goal is already in the pool' }, { status: 409 });

    const template = await prisma.projectTaskTemplate.create({
      data: { projectId: null, title, translations, createdById: session.user.id },
      select: { id: true, title: true, translations: true, useCount: true },
    });
    return NextResponse.json({ template: serialize(template) }, { status: 201 });
  });
}

// PATCH — rewrite a shared template in any/all languages.
export async function PATCH(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const target = await prisma.projectTaskTemplate.findFirst({
      where: { id: parsed.data.id, projectId: null },
      select: { id: true },
    });
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const translations = normalizeTranslations(parsed.data.translations);
    const title = canonicalTitle(translations);
    if (!title) return NextResponse.json({ error: 'Write the goal in at least one language' }, { status: 400 });

    const clash = await prisma.projectTaskTemplate.findFirst({
      where: { projectId: null, title, id: { not: target.id } },
      select: { id: true },
    });
    if (clash) return NextResponse.json({ error: 'That goal is already in the pool' }, { status: 409 });

    const template = await prisma.projectTaskTemplate.update({
      where: { id: target.id },
      data: { title, translations },
      select: { id: true, title: true, translations: true, useCount: true },
    });
    return NextResponse.json({ template: serialize(template) });
  });
}

// DELETE — drop a shared template. Goals already handed out are untouched: they
// are tasks of their own by then, not references to this row.
export async function DELETE(request: Request) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const deleted = await prisma.projectTaskTemplate.deleteMany({
      where: { id: parsed.data.id, projectId: null },
    });
    if (deleted.count === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  });
}
