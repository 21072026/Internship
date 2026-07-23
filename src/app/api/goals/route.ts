import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import type { Role } from '@prisma/client';
import { z } from 'zod';

async function relationIfAllowed(userId: string, role: string, relationId: string) {
  const rel = await prisma.mentorshipRelation.findUnique({ where: { id: relationId } });
  if (!rel) return null;
  const allowed = role === 'ADMIN' || rel.mentorId === userId || rel.menteeId === userId;
  return allowed ? rel : null;
}

// GET ?relationId= — goals for a relation (participants/admin).
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
  const relationId = new URL(request.url).searchParams.get('relationId') || '';

  const rel = await relationIfAllowed(session.user.id, session.user.role, relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const goals = await prisma.goal.findMany({ where: { relationId }, orderBy: { createdAt: 'asc' } });
  return NextResponse.json({ goals });
  });
}

const schema = z.object({
  relationId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  dueDate: z.string().optional(),
});

// POST — create a goal (participants/admin).
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

  const rel = await relationIfAllowed(session.user.id, session.user.role, parsed.data.relationId);
  if (!rel) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const goal = await prisma.goal.create({
    data: {
      relationId: rel.id,
      title: parsed.data.title,
      description: parsed.data.description || null,
      dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      // Record which side set the goal so it's clear who owns it.
      createdByRole: session.user.role as Role,
    },
  });
  return NextResponse.json({ goal }, { status: 201 });
  });
}
