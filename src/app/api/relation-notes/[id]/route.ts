import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const patchSchema = z.object({ body: z.string().min(1).max(5000) });

// PATCH — only the note's own author (or an admin) may edit it. `updatedAt`
// bumps automatically (schema @updatedAt).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const note = await prisma.relationNote.findUnique({ where: { id }, select: { authorId: true } });
  if (!note) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (note.authorId !== session.user.id && session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid body' }, { status: 400 });

  const updated = await prisma.relationNote.update({
    where: { id },
    data: { body: parsed.data.body.trim() },
    select: { id: true, body: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json({ note: updated });
}

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
