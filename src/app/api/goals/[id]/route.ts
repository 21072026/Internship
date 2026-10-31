import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { emit } from '@/lib/events/emit';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { notifyIfAllowed } from '@/lib/notify';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { resolveOrgId } from '@/lib/orgScope';
import { withTenantScope } from '@/lib/orgContext';
import { goalIfAllowed, readsAsAdmin } from '@/lib/goalAccess';
import { canDeleteGoal, canRewordGoal } from '@/lib/goalSubtasksRule';
import {
  canSetGoalVisibility,
  GOAL_PROGRESS_MAX,
  GOAL_PROGRESS_MIN,
  GOAL_VISIBILITIES,
} from '@/lib/goalVisibilityRule';

const patchSchema = z.object({
  status: z.enum(['OPEN', 'DONE']).optional(),
  title: z.string().min(1).max(TEXT_LIMITS.goalTitle).optional(),
  description: z.string().max(TEXT_LIMITS.goalDescription).nullable().optional(),
  dueDate: z.string().nullable().optional(),
  // #1858
  successCriteria: z.string().max(TEXT_LIMITS.goalSuccessCriteria).nullable().optional(),
  targetDate: z.string().nullable().optional(),
  progress: z.number().int().min(GOAL_PROGRESS_MIN).max(GOAL_PROGRESS_MAX).nullable().optional(),
  visibility: z.enum(GOAL_VISIBILITIES).optional(),
});

// PATCH — update a goal (toggle status, edit). Participants/admin.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;

  return await withTenantScope(session, async () => {
  const goal = await goalIfAllowed(session.user.id, session.user.role, id, resolveOrgId(session));
  if (goal === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!goal) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Same rule as creating one (#1408): a mentee cannot move the goals of a
  // mentorship that has ended. Mentor and admin are untouched.
  if (menteeWriteClosed(goal.relation, session.user.id)) {
    return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
  }

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { status, title, description, dueDate, successCriteria, targetDate, progress, visibility } = parsed.data;

  // A goal from the shared pool keeps the pool's wording (#1860), in every
  // language it was written in — the same rule as a pooled to-do.
  if (title !== undefined && title !== goal.title && !canRewordGoal(goal)) {
    return NextResponse.json({ error: 'This goal comes from the shared pool — edit the template instead', code: 'pooled_goal' }, { status: 409 });
  }

  // The sharing scope is the author's to set (#1858): the other participant
  // may tick and edit a shared goal, but not widen or narrow who reads it.
  const viewer = { id: session.user.id, role: session.user.role };
  const changesVisibility = visibility !== undefined && visibility !== goal.visibility;
  if (changesVisibility && !canSetGoalVisibility(goal, goal.relation, viewer)) {
    return NextResponse.json({ error: 'Forbidden', code: 'not_author' }, { status: 403 });
  }

  const updated = await prisma.goal.update({
    where: { id },
    data: {
      ...(status !== undefined ? { status, completedAt: status === 'DONE' ? new Date() : null } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {}),
      ...(successCriteria !== undefined ? { successCriteria: successCriteria?.trim() || null } : {}),
      ...(targetDate !== undefined ? { targetDate: targetDate ? new Date(targetDate) : null } : {}),
      ...(progress !== undefined ? { progress } : {}),
      // Narrowing to PRIVATE pins the author on a row that predates the
      // column, so the SQL-side readers (timeline) can name them too.
      ...(changesVisibility ? { visibility, ...(goal.createdById ? {} : { createdById: session.user.id }) } : {}),
    },
  });

  // Completion notifies the OTHER side (#925): mentee ticks it → mentor learns,
  // mentor ticks it → mentee learns. Only on a genuine OPEN→DONE transition —
  // re-saving an already-done goal (title edit etc.) stays silent. `goal` is
  // the pre-update row, so this compares against the old status. A PRIVATE
  // goal has no other side to tell.
  // On the bus too (#1998), under the same rule: a genuine completion of a
  // goal somebody else may read.
  if (status === 'DONE' && goal.status !== 'DONE' && updated.visibility !== 'PRIVATE') {
    await emit('goal.completed', { goalId: updated.id, relationId: updated.relationId }, { actor: { id: session.user.id, type: 'user' } });
  }
  if (status === 'DONE' && goal.status !== 'DONE' && updated.visibility !== 'PRIVATE') {
    const rel = goal.relation;
    const recipientId = session.user.id === rel.menteeId ? rel.mentorId : rel.menteeId;
    if (recipientId !== session.user.id) {
      const link = recipientId === rel.menteeId ? '/portal/goals' : `/mentor/mentees/${rel.id}`;
      await notifyIfAllowed(recipientId, 'goalsEvaluations', 'goal.completed', { title: updated.title }, link);
    }
  }
  return NextResponse.json({ goal: updated });
  });
}

// DELETE — remove a goal (participants/admin).
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'mentorship');
  if (capGate) return capGate;
  const { id } = await params;

  const goal = await goalIfAllowed(session.user.id, session.user.role, id, resolveOrgId(session));
  if (goal === 'missing') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!goal) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // A pooled goal is not its recipient's to make disappear (#1860); its steps
  // survive a deletion either way (ProjectTask.goalId is SetNull).
  if (!canDeleteGoal(goal, { id: session.user.id, isAdmin: readsAsAdmin(goal.relation, session.user.id) })) {
    return NextResponse.json({ error: 'This goal comes from the shared pool', code: 'pooled_goal' }, { status: 403 });
  }

  await prisma.goal.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
