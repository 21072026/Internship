import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { canManageProject, isProjectMember } from '@/lib/projectAccess';

// The goal/task template pool (#51).
//
// Every goal ever written on a project is worth keeping: the next person to join
// usually gets the same starter set ("read the project", "find one bug", "find
// one feature"). Templates are captured automatically when a task is created,
// and — the first time this endpoint is read for a project — backfilled from the
// tasks that already exist, so nothing written before this feature is lost.

const createSchema = z.object({ title: z.string().min(1).max(300) });
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

    // Lazy, idempotent backfill: adopt the wording of tasks that predate the
    // pool. `skipDuplicates` + the (projectId, title) unique key make repeat
    // reads free of writes.
    const [tasks, existing] = await Promise.all([
      prisma.projectTask.findMany({ where: { projectId: id }, select: { title: true } }),
      prisma.projectTaskTemplate.findMany({ where: { projectId: id }, select: { title: true } }),
    ]);
    const known = new Set(existing.map((t) => t.title));
    const missing = [...new Set(tasks.map((t) => t.title))].filter((title) => !known.has(title));
    if (missing.length > 0) {
      await prisma.projectTaskTemplate.createMany({
        data: missing.map((title) => ({ projectId: id, title })),
        skipDuplicates: true,
      });
    }

    const templates = await prisma.projectTaskTemplate.findMany({
      where: { OR: [{ projectId: id }, { projectId: null }] },
      orderBy: [{ useCount: 'desc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, useCount: true, projectId: true },
    });
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

    const template = await prisma.projectTaskTemplate.upsert({
      where: { projectId_title: { projectId: id, title: parsed.data.title } },
      update: {},
      create: { projectId: id, title: parsed.data.title, createdById: session.user.id },
      select: { id: true, title: true, useCount: true, projectId: true },
    });
    return NextResponse.json({ template }, { status: 201 });
  });
}

// DELETE — drop a template from this project's pool. Shared (global) templates
// are left alone here; they are not this project's to remove.
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

    await prisma.projectTaskTemplate.deleteMany({ where: { id: parsed.data.id, projectId: id } });
    return NextResponse.json({ ok: true });
  });
}
