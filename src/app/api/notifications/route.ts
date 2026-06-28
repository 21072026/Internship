import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

// GET — the current user's recent notifications + unread count.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.notification.count({ where: { userId: session.user.id, read: false } }),
  ]);
  return NextResponse.json({ items, unread });
}

// POST — mark notifications read (all, or a single id via { id }).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  await prisma.notification.updateMany({
    where: { userId: session.user.id, ...(body.id ? { id: body.id } : {}) },
    data: { read: true },
  });
  return NextResponse.json({ ok: true });
}
