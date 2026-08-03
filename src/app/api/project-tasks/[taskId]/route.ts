import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { canManageProject, isProjectMember, isProjectOwner } from '@/lib/projectAccess';
import { notify } from '@/lib/notify';

async function taskIfManageable(userId: string, role: string, companyId: string | null | undefined, taskId: string) {
  const task = await prisma.projectTask.findUnique({ where: { id: taskId }, include: { project: true } });
  if (!task) return null;
  // Tasks are collaborative (#619): owners AND mentor members may edit.
  if (canManageProject({ id: userId, role, companyId }, task.project)) return task;
  return (await isProjectMember({ id: userId, role, companyId }, task.projectId)) ? task : null;
}

const schema = z.object({
  done: z.boolean().optional(),
  title: z.string().min(1).max(300).optional(),
  // null clears the assignment (back to an unassigned project goal).
  assigneeId: z.string().min(1).nullable().optional(),
});

// PATCH — toggle done / rename / (re)assign a task.
//
// Who may change what (#51): renaming and handing a goal to *someone else* is a
// lead's call (owner or admin), while ticking a goal off and claiming an
// unassigned one are exactly what a member is there to do. Before this, a mentee
// member could technically call the endpoint but had no UI at all, so the list
// sat idle — visible to the owner, actionable by nobody.
export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { taskId } = await params;

  const task = await taskIfManageable(session.user.id, session.user.role, session.user.companyId, taskId);
  if (!task) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const lead = await isProjectOwner(session.user, task.projectId);

  if (parsed.data.title !== undefined && !lead) {
    return NextResponse.json({ error: 'Only a project owner can rename a goal' }, { status: 403 });
  }

  let assigneeId: string | null | undefined;
  if (parsed.data.assigneeId !== undefined) {
    const target = parsed.data.assigneeId;
    const claimingSelf = target === session.user.id && task.assigneeId === null;
    const releasingOwn = target === null && task.assigneeId === session.user.id;
    if (!lead && !claimingSelf && !releasingOwn) {
      return NextResponse.json({ error: 'Only a project owner can assign this goal' }, { status: 403 });
    }
    if (target) {
      const member = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: task.projectId, userId: target } },
        select: { id: true },
      });
      const legacy = member
        ? null
        : await prisma.mentorshipRelation.findFirst({
            where: { projectId: task.projectId, menteeId: target },
            select: { id: true },
          });
      if (!member && !legacy) {
        return NextResponse.json({ error: 'The assignee must be a project member' }, { status: 400 });
      }
    }
    assigneeId = target;
  }

  // Ticking off someone else's personal goal is not a member's call either.
  if (parsed.data.done !== undefined && !lead && task.assigneeId && task.assigneeId !== session.user.id) {
    return NextResponse.json({ error: 'This goal belongs to someone else' }, { status: 403 });
  }

  const updated = await prisma.projectTask.update({
    where: { id: taskId },
    data: {
      ...(parsed.data.done !== undefined ? { done: parsed.data.done, doneAt: parsed.data.done ? new Date() : null } : {}),
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
    },
  });

  if (assigneeId && assigneeId !== session.user.id) {
    await notify(assigneeId, 'project', `You were given a goal: ${updated.title}`, `/projects/${task.projectId}`);
  }
  return NextResponse.json({ task: updated });
}

// DELETE — remove a task. Unchanged for the people who always had this button
// (owners and mentor/admin members); a mentee member, who only got a task UI
// now, may delete their own goal and nothing else.
export async function DELETE(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { taskId } = await params;

  const task = await taskIfManageable(session.user.id, session.user.role, session.user.companyId, taskId);
  if (!task) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (session.user.role === 'MENTEE' && task.assigneeId !== session.user.id) {
    return NextResponse.json({ error: 'This goal belongs to the project' }, { status: 403 });
  }

  await prisma.projectTask.delete({ where: { id: taskId } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
