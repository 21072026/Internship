import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { notify } from '@/lib/notify';

const schema = z.object({ answer: z.string().min(1).max(4000) });

// PATCH — the mentor (or admin) answers a question.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const q = await prisma.mentorQuestion.findUnique({ where: { id }, include: { relation: true } });
  if (!q) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const allowed = session.user.role === 'ADMIN' || q.relation.mentorId === session.user.id;
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const updated = await prisma.mentorQuestion.update({
    where: { id },
    data: { answer: parsed.data.answer, answeredAt: new Date() },
  });
  await notify(q.askedById, 'question', 'Your mentor answered your question.', '/portal');
  return NextResponse.json({ question: updated });
}
