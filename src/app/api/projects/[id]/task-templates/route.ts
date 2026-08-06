import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { canManageProject, isProjectMember } from '@/lib/projectAccess';
import { canonicalTitle, normalizeTranslations, readTranslations } from '@/lib/goalTemplates';

// The goal/task template pool (#51, reworked in #1113).
//
// This is the shortlist a lead picks from when handing work to a new member:
// **this project's own hand-written templates plus the shared (admin-managed)
// ones**, and nothing else. It used to also absorb every task on the project —
// captured on create, backfilled on read — which meant the to-dos that had just
// been handed out reappeared here as templates, once per language they were
// resolved into, and the same wording piled up round after round. Nothing is
// captured implicitly any more: a template exists because someone added it.
//
// Removing a template archives it (`archivedAt`) rather than deleting the row:
// a to-do handed out from the pool *references* its template, so deleting it
// would blank the wording for everyone who has it. Archived means "stop offering
// this"; adding the same wording back revives the row.

const localeText = z.string().trim().max(300).optional();
const translationsSchema = z.object({ en: localeText, tr: localeText, de: localeText });
// `title` alone is still accepted: that is how the automatic capture and the
// older clients add a template.
const createSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  translations: translationsSchema.optional(),
});
const updateSchema = z.object({ id: z.string().min(1), translations: translationsSchema });
const deleteSchema = z.object({ id: z.string().min(1) });

async function access(session: { user: { id: string; role: string; companyId?: string | null } }, projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerType: true, ownerUserId: true, ownerCompanyId: true },
  });
  if (!project) return { status: 404 as const };
  const manage = canManageProject(session.user, project) || (await isProjectMember(session.user, projectId));
  return { project, manage };
}

// GET — the pool available to this project: its own templates plus the shared
// (project-less) ones, most-used first.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const a = await access(session, id);
    if (a.status === 404) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!a.manage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const rows = await prisma.projectTaskTemplate.findMany({
      where: { archivedAt: null, OR: [{ projectId: id }, { projectId: null }] },
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, translations: true, useCount: true, projectId: true },
    });
    // `shared` tells the UI which rows are the admin-managed pool: they show up
    // in every project, so they are not this project's to rename or remove.
    const templates = rows.map((t) => ({
      id: t.id,
      title: t.title,
      translations: readTranslations(t.translations),
      useCount: t.useCount,
      projectId: t.projectId,
      shared: t.projectId === null,
    }));
    return NextResponse.json({ templates });
  });
}

// POST — add a template by hand (the automatic capture covers the rest).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const a = await access(session, id);
    if (a.status === 404) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!a.manage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const translations = normalizeTranslations(parsed.data.translations);
    const title = canonicalTitle(translations, parsed.data.title);
    if (!title) return NextResponse.json({ error: 'Write the goal in at least one language' }, { status: 400 });

    // Adding a wording that was archived earlier revives that row, so the to-dos
    // already handed out from it stay attached to the template they came from.
    const template = await prisma.projectTaskTemplate.upsert({
      where: { projectId_title: { projectId: id, title } },
      update: { archivedAt: null, ...(Object.keys(translations).length > 0 ? { translations } : {}) },
      create: { projectId: id, title, translations, createdById: session.user.id },
      select: { id: true, title: true, translations: true, useCount: true, projectId: true },
    });
    return NextResponse.json(
      { template: { ...template, translations: readTranslations(template.translations), shared: false } },
      { status: 201 }
    );
  });
}

// PATCH — rewrite one of this project's own templates in any/all languages.
// A shared template is not this project's to reword: it appears in every
// project, so an admin owns it (/api/admin/goal-templates).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const a = await access(session, id);
    if (a.status === 404) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!a.manage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const target = await prisma.projectTaskTemplate.findFirst({
      where: { id: parsed.data.id, projectId: id, archivedAt: null },
      select: { id: true },
    });
    if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const translations = normalizeTranslations(parsed.data.translations);
    const title = canonicalTitle(translations);
    if (!title) return NextResponse.json({ error: 'Write the goal in at least one language' }, { status: 400 });

    const clash = await prisma.projectTaskTemplate.findFirst({
      where: { projectId: id, title, id: { not: target.id } },
      select: { id: true },
    });
    if (clash) return NextResponse.json({ error: 'That goal is already in the pool' }, { status: 409 });

    const template = await prisma.projectTaskTemplate.update({
      where: { id: target.id },
      data: { title, translations },
      select: { id: true, title: true, translations: true, useCount: true, projectId: true },
    });
    return NextResponse.json({
      template: { ...template, translations: readTranslations(template.translations), shared: false },
    });
  });
}

// DELETE — retire a template from this project's pool. The row is archived, not
// removed: the to-dos handed out from it point at it, and their wording is read
// from it. Deleting means "don't hand this out again", never "take it away from
// the people who already have it". Shared (global) templates are left alone
// here; they are not this project's to retire.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const a = await access(session, id);
    if (a.status === 404) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!a.manage) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    await prisma.projectTaskTemplate.updateMany({
      where: { id: parsed.data.id, projectId: id, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  });
}
