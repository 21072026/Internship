import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { INACTIVE_RELATION_ERROR, menteeWriteClosed } from '@/lib/menteeRelation';
import { notifyIfAllowed } from '@/lib/notify';
import { z } from 'zod';

async function goalIfAllowed(userId: string, role: string, goalId: string) {
  const goal = await prisma.goal.findUnique({ where: { id: goalId }, include: { relation: true } });
  if (!goal) return null;
  const rel = goal.relation;
  const allowed = role === 'ADMIN' || rel.mentorId === userId || rel.menteeId === userId;
  return allowed ? goal : null;
}

const patchSchema = z.object({
  status: z.enum(['OPEN', 'DONE']).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  dueDate: z.string().nullable().optional(),
});

// PATCH — update a goal (toggle status, edit). Participants/admin.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const goal = await goalIfAllowed(session.user.id, session.user.role, id);
  if (!goal) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Same rule as creating one (#1408): a mentee cannot move the goals of a
  // mentorship that has ended. Mentor and admin are untouched.
  if (menteeWriteClosed(goal.relation, session.user.id)) {
    return NextResponse.json(INACTIVE_RELATION_ERROR, { status: 409 });
  }

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const { status, title, description, dueDate } = parsed.data;

  const updated = await prisma.goal.update({
    where: { id },
    data: {
      ...(status !== undefined ? { status, completedAt: status === 'DONE' ? new Date() : null } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {}),
    },
  });

  // Completion notifies the OTHER side (#925): mentee ticks it → mentor learns,
  // mentor ticks it → mentee learns. Only on a genuine OPEN→DONE transition —
  // re-saving an already-done goal (title edit etc.) stays silent. `goal` is
  // the pre-update row, so this compares against the old status.
  if (status === 'DONE' && goal.status !== 'DONE') {
    const rel = goal.relation;
    const recipientId = session.user.id === rel.menteeId ? rel.mentorId : rel.menteeId;
    if (recipientId !== session.user.id) {
      const link = recipientId === rel.menteeId ? '/portal/goals' : `/mentor/mentees/${rel.id}`;
      await notifyIfAllowed(recipientId, 'goalsEvaluations', 'goal.completed', { title: updated.title }, link);
    }
  }
  return NextResponse.json({ goal: updated });
}

// DELETE — remove a goal (participants/admin).
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const goal = await goalIfAllowed(session.user.id, session.user.role, id);
  if (!goal) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  await prisma.goal.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
