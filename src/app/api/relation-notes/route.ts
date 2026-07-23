import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

const bodySchema = z.object({
  relationId: z.string().min(1),
  body: z.string().min(1).max(5000),
});

// A note is visible/writable only to the mentor of that relation, or an admin.
async function canAccessRelation(userId: string, role: string, relationId: string) {
  if (role === 'ADMIN') return true;
  if (role !== 'MENTOR') return false;
  const rel = await prisma.mentorshipRelation.findFirst({ where: { id: relationId, mentorId: userId }, select: { id: true } });
  return !!rel;
}

// GET ?relationId=... — mentor-private notes on a mentorship relation
// (EPIC: mentor private notes). Never exposed to the mentee.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const relationId = new URL(request.url).searchParams.get('relationId');
    if (!relationId) return NextResponse.json({ error: 'relationId is required' }, { status: 400 });
    if (!(await canAccessRelation(session.user.id, session.user.role, relationId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const notes = await prisma.relationNote.findMany({
      where: { relationId },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: { fullName: true } } },
    });
    return NextResponse.json({ notes });
  });
}

// POST — add a note.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { relationId, body } = parsed.data;

    if (!(await canAccessRelation(session.user.id, session.user.role, relationId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const note = await prisma.relationNote.create({
      data: { relationId, authorId: session.user.id, body },
      include: { author: { select: { fullName: true } } },
    });
    return NextResponse.json({ note }, { status: 201 });
  });
}
