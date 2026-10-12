import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { notify } from '@/lib/notify';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { findActionItem, normalizeActionText } from '@/lib/minutesActionItems';
import {
  ADMIN_READ_ONLY_ERROR,
  announceSessionNoteChange,
  canAuthor,
  serializeSessionNote,
  sessionNoteIfAllowed,
  sessionNoteInclude,
  viewerOf,
} from '@/lib/sessionNoteAccess';

// Promote a `- [ ]` line of the minutes to a to-do (#1849): a personal
// ProjectTask on the mentor's or the mentee's list, written with the same
// authorization POST /api/todos applies to a hand-written line — the author is
// whoever promoted it, the assignee is one of the two seats, and the assignee
// is told the way a handed-out to-do tells them. The link row keeps the two in
// step from then on (src/lib/minutesSync.ts).

const schema = z.object({
  text: z.string().trim().min(1).max(TEXT_LIMITS.todoTitle),
  assigneeId: z.string().min(1),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;
  return await withTenantScope(session, async () => {
    const note = await sessionNoteIfAllowed(session, id);
    if (note === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!note) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const viewer = viewerOf(session);
    if (!canAuthor(note.relation, viewer)) return NextResponse.json(ADMIN_READ_ONLY_ERROR, { status: 403 });
    if (menteeWriteClosed(note.relation, session.user.id)) return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { text, assigneeId } = parsed.data;

    // The to-do goes to one of the two seats and nobody else: that is the
    // reach the to-do API grants a mentor over their mentee, and a mentee has
    // over themselves — anything wider would be new access.
    if (assigneeId !== note.relation.mentorId && assigneeId !== note.relation.menteeId) {
      return NextResponse.json({ error: 'The assignee must be the mentor or the mentee of this pairing', code: 'not_a_seat' }, { status: 400 });
    }
    const line = findActionItem(note.body, text);
    if (!line) return NextResponse.json({ error: 'That line is not an action item of these minutes', code: 'line_not_found' }, { status: 400 });
    const wanted = normalizeActionText(text);
    if (note.actionItems.some((a) => normalizeActionText(a.text) === wanted)) {
      return NextResponse.json({ error: 'That line already has a to-do', code: 'already_promoted' }, { status: 409 });
    }

    const task = await prisma.projectTask.create({
      data: {
        title: line.text.slice(0, TEXT_LIMITS.todoTitle),
        assigneeId,
        createdById: session.user.id,
        projectId: null,
        done: line.done,
        doneAt: line.done ? new Date() : null,
      },
      select: { id: true, title: true },
    });
    await prisma.sessionNoteActionItem.create({ data: { noteId: note.id, taskId: task.id, text: line.text } });
    if (assigneeId !== session.user.id) {
      await notify(assigneeId, 'project.newTodo', { title: task.title }, '/todos');
    }
    announceSessionNoteChange(note.relation, note.relationId, session.user.id);
    const updated = await prisma.sessionNote.findUniqueOrThrow({ where: { id: note.id }, include: sessionNoteInclude });
    return NextResponse.json({ note: serializeSessionNote(updated), taskId: task.id }, { status: 201 });
  });
}
