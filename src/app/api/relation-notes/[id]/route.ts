import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// DELETE — only the note's own author (or an admin) may remove it.
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const note = await prisma.relationNote.findUnique({ where: { id }, select: { authorId: true } });
  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (note.authorId !== session.user.id && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await prisma.relationNote.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
