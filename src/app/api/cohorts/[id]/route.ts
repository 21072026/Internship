import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  term: z.string().max(60).nullable().optional(),
});

// PATCH — rename / re-term a cohort (admin).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const cohort = await prisma.cohort.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.term !== undefined ? { term: parsed.data.term || null } : {}),
    },
  });
  return NextResponse.json({ cohort });
}

// DELETE — remove a cohort (admin). Relations keep their record; their cohortId
// is cleared so no mentee is orphaned.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  await prisma.mentorshipRelation.updateMany({ where: { cohortId: id }, data: { cohortId: null } });
  await prisma.cohort.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
