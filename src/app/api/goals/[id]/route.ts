import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { requireCapability } from '@/lib/capabilityGate';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { notifyIfAllowed } from '@/lib/notify';
import { z } from 'zod';
import { TEXT_LIMITS } from '@/lib/textLimits';
import { resolveOrgId } from '@/lib/orgScope';
import { inCallerTenant } from '@/lib/tenantFilter';
import { withTenantScope } from '@/lib/orgContext';
import {
  canReachGoals,
  canReadGoal,
  canSetGoalVisibility,
  GOAL_PROGRESS_MAX,
  GOAL_PROGRESS_MIN,
  GOAL_VISIBILITIES,
} from '@/lib/goalVisibilityRule';

// 'missing' covers another tenant's goal too (#2542): Goal has no orgId, the
// nested relation include is never scoped, so the tenant is checked here, and
// the answer is the 404 a missing id gets — a 403 would confirm the id exists.
// A PRIVATE goal of someone else (#1858) gets the same 'missing' for the same
// reason: the other side must not learn that a goal they cannot read exists.
async function goalIfAllowed(userId: string, role: string, goalId: string, callerOrgId: string | null) {
  const goal = await prisma.goal.findUnique({ where: { id: goalId }, include: { relation: true } });
  if (!goal || !(await inCallerTenant(goal.relation.orgId, callerOrgId))) return 'missing' as const;
  const viewer = { id: userId, role };
  if (!canReachGoals(goal.relation, viewer)) return null;
  return canReadGoal(goal, goal.relation, viewer) ? goal : ('missing' as const);
}

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

  await prisma.goal.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
