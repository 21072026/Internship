import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — recent activity for a single user (as actor or target). Visible to the
// user themselves, any admin, or a mentor who mentors that user. Also returns
// lastActiveAt so callers can flag inactivity.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  let allowed = session.user.id === id || session.user.role === 'ADMIN';
  if (!allowed && session.user.role === 'MENTOR') {
    const rel = await prisma.mentorshipRelation.findFirst({ where: { mentorId: session.user.id, menteeId: id }, select: { id: true } });
    allowed = !!rel;
  }
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const [items, lastActive] = await Promise.all([
    prisma.activityLog.findMany({
      where: { OR: [{ actorId: id }, { targetId: id }] },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
    prisma.activityLog.findFirst({
      where: { actorId: id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);

  return NextResponse.json({ items, lastActiveAt: lastActive?.createdAt ?? null });
}
