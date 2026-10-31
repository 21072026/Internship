import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireCapability } from '@/lib/capabilityGate';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { goalIfAllowed } from '@/lib/goalAccess';
import { notifyIfAllowed } from '@/lib/notify';
import { TEXT_LIMITS } from '@/lib/textLimits';

// POST — add a step to a goal (#1860). A step IS a to-do (ProjectTask with
// `goalId`): it lands on its assignee's /todos list, ticks there and here, and
// is changed or deleted through /api/project-tasks/[taskId] like any to-do —
// that route reaches it through the goal's own reading rule. Whoever may read
// the goal adds steps to it; the assignee is one of the pair (the mentee when
// none is named).
const schema = z.object({
  title: z.string().trim().min(1).max(TEXT_LIMITS.todoTitle),
  assigneeId: z.string().min(1).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;

  return await withTenantScope(session, async () => {
    const goal = await goalIfAllowed(session.user.id, session.user.role, id, resolveOrgId(session));
    if (goal === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!goal) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (menteeWriteClosed(goal.relation, session.user.id)) return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });

    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const assigneeId = parsed.data.assigneeId ?? goal.relation.menteeId;
    if (assigneeId !== goal.relation.menteeId && assigneeId !== goal.relation.mentorId) {
      return NextResponse.json({ error: 'A step is assigned to one of the pair', code: 'invalid_assignee' }, { status: 400 });
    }

    const task = await prisma.projectTask.create({
      data: { title: parsed.data.title, goalId: goal.id, assigneeId, createdById: session.user.id },
      select: { id: true, title: true, done: true, assigneeId: true, createdById: true, goalId: true },
    });
    // A PRIVATE goal has nobody else to tell; otherwise the assignee learns,
    // unless they wrote the step themselves.
    if (assigneeId !== session.user.id && goal.visibility !== 'PRIVATE') {
      await notifyIfAllowed(assigneeId, 'goalsEvaluations', 'goal.stepAssigned', { title: task.title, goal: goal.title }, assigneeId === goal.relation.menteeId ? '/portal/goals' : `/mentor/mentees/${goal.relationId}`);
    }
    return NextResponse.json({ task }, { status: 201 });
  });
}
