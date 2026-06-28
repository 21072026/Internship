import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

const PAGE_SIZE = 50;
const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'] as const;

// GET — admin activity feed with filters: level, action (contains), q (actor
// email contains), and page.
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = new URL(request.url).searchParams;
  const level = sp.get('level');
  const action = sp.get('action');
  const q = sp.get('q');
  const page = Math.max(1, Number(sp.get('page')) || 1);

  const where: Prisma.ActivityLogWhereInput = {};
  if (level && (LEVELS as readonly string[]).includes(level)) where.level = level as (typeof LEVELS)[number];
  if (action) where.action = { contains: action };
  if (q) where.actorEmail = { contains: q };

  const [items, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.activityLog.count({ where }),
  ]);

  return NextResponse.json({ items, total, page, pageSize: PAGE_SIZE });
}
