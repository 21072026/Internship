import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
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
