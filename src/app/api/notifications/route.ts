import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const markReadSchema = z.object({
  id: z.string().min(1).optional(),
});

const READ_FILTERS = new Set(['all', 'read', 'unread']);

// GET — the current user's notifications. With no query params this returns
// the last 20 (unfiltered) + unread count, exactly as before (NotificationBell
// depends on this default shape). Optional `page`/`pageSize`/`read`/`type`
// params add pagination and filtering for the /notifications history page.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10) || 20));
  const readParam = searchParams.get('read') || 'all';
  const read = READ_FILTERS.has(readParam) ? readParam : 'all';
  const type = searchParams.get('type') || undefined;

  const where = {
    userId: session.user.id,
    ...(read === 'unread' ? { read: false } : read === 'read' ? { read: true } : {}),
    ...(type ? { type } : {}),
  };

  const [items, total, unread, typeRows] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: session.user.id, read: false } }),
    prisma.notification.findMany({
      where: { userId: session.user.id },
      distinct: ['type'],
      select: { type: true },
      orderBy: { type: 'asc' },
    }),
  ]);

  return NextResponse.json({
    items,
    unread,
    total,
    page,
    pageSize,
    types: typeRows.map((r) => r.type),
  });
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
