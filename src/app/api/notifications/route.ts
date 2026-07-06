import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const markReadSchema = z.object({
  id: z.string().min(1).optional(),
});

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
  const parsed = markReadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }

  await prisma.notification.updateMany({
    where: { userId: session.user.id, ...(parsed.data.id ? { id: parsed.data.id } : {}) },
    data: { read: true },
  });
  return NextResponse.json({ ok: true });
}
