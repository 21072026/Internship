import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { withTenantScope } from '@/lib/orgContext';

// Turn one line of a note into a real piece of work (#1059).
//
// No new model: Goal and ProjectTask already exist. The value here is that the
// "we'll do X" buried in a meeting note stops being buried.

const schema = z
  .object({
    line: z.string().min(1).max(500),
    target: z.enum(['GOAL', 'PROJECT_TASK']),
    relationId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    assigneeId: z.string().min(1).optional(),
  })
  .refine((d) => (d.target === 'GOAL' ? !!d.relationId : !!d.projectId), {
    message: 'A GOAL needs relationId; a PROJECT_TASK needs projectId',
  });

// A converted line is marked in the note body so the same sentence can't be
// turned into two tasks by two clicks.
const DONE_MARK = '✓ ';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  return await withTenantScope(session, async () => {
    const note = await prisma.personalNote.findUnique({ where: { id } });
    if (!note || note.userId !== session.user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    }
    const { line, target, relationId, projectId, assigneeId } = parsed.data;

    // The line has to actually be in the note — otherwise this endpoint is a
    // generic "create a task anywhere" hidden behind a note id.
    const lines = note.body.split('\n');
    const index = lines.findIndex((l) => l.trim() === line.trim());
    if (index === -1) return NextResponse.json({ error: 'Line not found in note' }, { status: 400 });
    if (lines[index].trimStart().startsWith(DONE_MARK.trim())) {
      return NextResponse.json({ error: 'Already converted' }, { status: 409 });
    }

    if (target === 'GOAL') {
      // Only the mentor of that relation (or an admin) may set a goal on it.
      const relation = await prisma.mentorshipRelation.findUnique({
        where: { id: relationId! },
        select: { mentorId: true },
      });
      if (!relation) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (session.user.role !== 'ADMIN' && relation.mentorId !== session.user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const goal = await prisma.goal.create({
        data: {
          relationId: relationId!,
          title: line.trim().slice(0, 191),
          createdByRole: session.user.role === 'MENTEE' ? 'MENTEE' : 'MENTOR',
        },
      });
      await markConverted(note.id, lines, index);
      return NextResponse.json({ goal }, { status: 201 });
    }

    // Project is a TENANT_MODEL and ProjectMember is not, so read the project
    // first — querying members directly would reach across tenants.
    const project = await prisma.project.findUnique({ where: { id: projectId! }, select: { id: true } });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: projectId!, userId: session.user.id } },
      select: { id: true },
    });
    if (session.user.role !== 'ADMIN' && !member) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // An assignee who isn't on the project would get a task they can't see.
    if (assigneeId) {
      const assignee = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: projectId!, userId: assigneeId } },
        select: { id: true },
      });
      if (!assignee) return NextResponse.json({ error: 'Assignee is not a project member' }, { status: 400 });
    }
    const task = await prisma.projectTask.create({
      data: {
        projectId: projectId!,
        title: line.trim().slice(0, 191),
        assigneeId: assigneeId ?? null,
      },
    });
    await markConverted(note.id, lines, index);
    return NextResponse.json({ task }, { status: 201 });
  });
}

// Mark in place rather than deleting the line: the note is the record of what
// was said, and removing sentences from it would quietly rewrite history.
async function markConverted(noteId: string, lines: string[], index: number) {
  const next = [...lines];
  next[index] = `${DONE_MARK}${lines[index].trimStart()}`;
  await prisma.personalNote.update({ where: { id: noteId }, data: { body: next.join('\n') } });
}
