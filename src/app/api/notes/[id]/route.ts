import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const schema = z.object({ body: z.string().min(1).max(5000) });

// Only the owner may edit/delete their note.
async function ownNote(userId: string, id: string) {
  const note = await prisma.personalNote.findUnique({ where: { id } });
  return note && note.userId === userId ? note : null;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!(await ownNote(session.user.id, id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  const note = await prisma.personalNote.update({ where: { id }, data: { body: parsed.data.body } });
  return NextResponse.json({ note });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!(await ownNote(session.user.id, id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  await prisma.personalNote.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
