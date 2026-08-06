import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { canManageProject, isProjectMember, isProjectOwner } from '@/lib/projectAccess';
import { notify } from '@/lib/notify';
import { goalLinkFor } from '@/lib/projectGoalLink';

// One to-do: tick it off, put it away, reword it, hand it over.
//
// Three kinds of row reach this endpoint (see ProjectTask in the schema):
//   - a project to-do          — access follows the project (owner or member)
//   - a personal to-do         — no project; the assignee, its author, an admin
//   - a shared (pooled) to-do  — `templateId` set: the wording lives in the
//                                template, so it cannot be reworded here, and the
//                                person it was given to cannot delete it either.
//                                They tick it off and archive it (#1113).
async function taskFor(
  user: { id: string; role: string; companyId?: string | null },
  taskId: string
) {
  const task = await prisma.projectTask.findUnique({ where: { id: taskId }, include: { project: true } });
  if (!task) return null;
  // A personal to-do has no project to derive access from: it belongs to the
  // person it is on, and to whoever wrote it (their mentor) — plus an admin.
  if (!task.projectId || !task.project) {
    const own = task.assigneeId === user.id || task.createdById === user.id;
    return own || user.role === 'ADMIN' ? task : null;
  }
  // Project tasks are collaborative (#619): owners AND mentor members may edit.
  if (canManageProject(user, task.project)) return task;
  return (await isProjectMember(user, task.projectId)) ? task : null;
}

const schema = z.object({
  done: z.boolean().optional(),
  // Finished and put away — leaves the active list without losing the record.
  archived: z.boolean().optional(),
  title: z.string().min(1).max(300).optional(),
  // null clears the assignment (back to an unassigned project goal).
  assigneeId: z.string().min(1).nullable().optional(),
});

// PATCH — toggle done / archive / rename / (re)assign a task.
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

  const task = await taskFor(session.user, taskId);
  if (!task) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  // "Lead" is whoever the to-do is answerable to: the project's owner, or — with
  // no project above it — whoever put it on the list. A to-do you wrote yourself
  // makes you both, which is why your own lines stay fully yours.
  const lead = task.projectId
    ? await isProjectOwner(session.user, task.projectId)
    : task.createdById === session.user.id || session.user.role === 'ADMIN';
  const mine = task.assigneeId === session.user.id;

  if (parsed.data.title !== undefined) {
    // A shared to-do's wording belongs to the template, in every language it was
    // written in. Rewording it here would fork one person's copy off the pool and
    // undo the point of the reference.
    if (task.templateId) {
      return NextResponse.json(
        { error: 'This to-do comes from the shared pool — edit the template instead' },
        { status: 409 }
      );
    }
    // Your own personal to-do is yours to reword; a project to-do is the lead's.
    if (!lead) {
      return NextResponse.json({ error: 'This to-do is not yours to reword' }, { status: 403 });
    }
  }

  let assigneeId: string | null | undefined;
  if (parsed.data.assigneeId !== undefined) {
    const target = parsed.data.assigneeId;
    const claimingSelf = target === session.user.id && task.assigneeId === null;
    const releasingOwn = target === null && task.assigneeId === session.user.id;
    if (!lead && !claimingSelf && !releasingOwn) {
      return NextResponse.json({ error: 'Only a project owner can assign this goal' }, { status: 403 });
    }
    // A personal to-do belongs to one person; there is no pool to give it back to.
    if (!task.projectId && target === null) {
      return NextResponse.json({ error: 'A personal to-do cannot be unassigned' }, { status: 400 });
    }
    if (target && task.projectId) {
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

  // Ticking off (or putting away) someone else's personal goal is not a member's
  // call either.
  if ((parsed.data.done !== undefined || parsed.data.archived !== undefined) && !lead && task.assigneeId && !mine) {
    return NextResponse.json({ error: 'This goal belongs to someone else' }, { status: 403 });
  }

  const updated = await prisma.projectTask.update({
    where: { id: taskId },
    data: {
      ...(parsed.data.done !== undefined ? { done: parsed.data.done, doneAt: parsed.data.done ? new Date() : null } : {}),
      ...(parsed.data.archived !== undefined
        ? { archivedAt: parsed.data.archived ? new Date() : null }
        : {}),
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
    },
  });

  if (assigneeId && assigneeId !== session.user.id) {
    await notify(
      assigneeId,
      'project',
      `You were given a goal: ${updated.title}`,
      await goalLinkFor(assigneeId, task.projectId)
    );
  }
  return NextResponse.json({ task: updated });
}

// DELETE — remove a task. Unchanged for the people who always had this button
// (owners and mentor/admin members); a mentee member, who only got a task UI
// now, may delete their own goal and nothing else — and never a shared one,
// which is the pool's to retire, not theirs (#1113). Archiving is what a person
// does with a to-do they are finished with.
export async function DELETE(_request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { taskId } = await params;

  const task = await taskFor(session.user, taskId);
  if (!task) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const lead = task.projectId
    ? await isProjectOwner(session.user, task.projectId)
    : task.createdById === session.user.id || session.user.role === 'ADMIN';
  if (task.projectId && session.user.role === 'MENTEE' && task.assigneeId !== session.user.id) {
    return NextResponse.json({ error: 'This goal belongs to the project' }, { status: 403 });
  }
  // A to-do that came from the shared pool is not the recipient's to delete: it
  // was handed to them, and it disappears when whoever leads the project (or an
  // admin) takes it back.
  if (task.templateId && !lead) {
    return NextResponse.json(
      { error: 'This to-do comes from the shared pool — tick it off and archive it instead' },
      { status: 403 }
    );
  }

  await prisma.projectTask.delete({ where: { id: taskId } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
