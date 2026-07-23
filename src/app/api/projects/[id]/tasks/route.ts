import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { canManageProject, isProjectMember } from '@/lib/projectAccess';
import { withTenantScope } from '@/lib/orgContext';

const schema = z.object({ title: z.string().min(1).max(300) });

// POST — add a task to a project (project managers only).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;

    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Tasks are collaborative (#619): owners AND mentor members may edit.
    if (!canManageProject(session.user, project) && !(await isProjectMember(session.user, id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const count = await prisma.projectTask.count({ where: { projectId: id } });
    const task = await prisma.projectTask.create({
      data: { projectId: id, title: parsed.data.title, order: count },
    });
    return NextResponse.json({ task }, { status: 201 });
  });
}
