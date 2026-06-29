import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { canManageProject } from '@/lib/projectAccess';

async function taskIfManageable(userId: string, role: string, companyId: string | null | undefined, taskId: string) {
  const task = await prisma.projectTask.findUnique({ where: { id: taskId }, include: { project: true } });
  if (!task) return null;
  return canManageProject({ id: userId, role, companyId }, task.project) ? task : null;
}

const schema = z.object({
  done: z.boolean().optional(),
  title: z.string().min(1).max(300).optional(),
});

// PATCH — toggle done / rename a task (project managers only).
export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { taskId } = await params;

  const task = await taskIfManageable(session.user.id, session.user.role, session.user.companyId, taskId);
  if (!task) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const updated = await prisma.projectTask.update({
    where: { id: taskId },
    data: {
      ...(parsed.data.done !== undefined ? { done: parsed.data.done } : {}),
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
    },
  });
  return NextResponse.json({ task: updated });
}

// DELETE — remove a task (project managers only).
export async function DELETE(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { taskId } = await params;

  const task = await taskIfManageable(session.user.id, session.user.role, session.user.companyId, taskId);
  if (!task) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  await prisma.projectTask.delete({ where: { id: taskId } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
