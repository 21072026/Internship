import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { resolveOwner } from '@/lib/projectAccess';
import { logActivity } from '@/lib/activity';

const include = {
  ownerUser: { select: { id: true, fullName: true, role: true } },
  ownerCompany: { select: { id: true, name: true } },
  tasks: { orderBy: { order: 'asc' } },
  // Member (mentee) names for the card's "who's on it" row (#616).
  relations: {
    where: { status: 'ACTIVE' },
    select: { mentee: { select: { id: true, fullName: true } } },
    take: 12,
  },
  _count: { select: { relations: true } },
} as const;

// GET — projects visible to the caller (admin: all; mentor: owned; company: their company's).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let where: Prisma.ProjectWhereInput = {};
  if (session.user.role === 'MENTOR') where = { ownerUserId: session.user.id };
  else if (session.user.role === 'COMPANY') where = { ownerCompanyId: session.user.companyId ?? '__none__' };
  else if (session.user.role === 'MENTEE') where = { isPublic: true };

  const projects = await prisma.project.findMany({ where, include, orderBy: { updatedAt: 'desc' } });
  // Mentees only browse the public showcase set — keep it PII-free (count only).
  if (session.user.role === 'MENTEE') {
    return NextResponse.json({ projects: projects.map(({ relations: _relations, ...rest }) => rest) });
  }
  return NextResponse.json({ projects });
}

const schema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  technologies: z.array(z.string()).max(50).optional(),
  repoUrl: z.string().url().max(500).optional().or(z.literal('')),
  demoUrl: z.string().url().max(500).optional().or(z.literal('')),
  boardUrl: z.string().url().max(500).optional().or(z.literal('')),
  status: z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED', 'CANCELLED']).optional(),
  isPublic: z.boolean().optional(),
  goals: z.string().max(5000).optional().nullable(),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  ownerType: z.enum(['ADMIN', 'MENTOR', 'COMPANY']).optional(),
  ownerUserId: z.string().optional().nullable(),
  ownerCompanyId: z.string().optional().nullable(),
});

// POST — create a project. Admin may set any owner; a mentor always owns it.
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== 'ADMIN' && session.user.role !== 'MENTOR')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  // Resolve & authorize ownership (no orphan projects).
  let owner;
  if (session.user.role === 'MENTOR') {
    owner = { ownerType: 'MENTOR' as const, ownerUserId: session.user.id, ownerCompanyId: null };
  } else {
    // ADMIN ownership defaults to the acting admin when no user id is supplied.
    const ownerUserId = d.ownerType === 'ADMIN' ? d.ownerUserId || session.user.id : d.ownerUserId;
    owner = await resolveOwner({ ownerType: d.ownerType, ownerUserId, ownerCompanyId: d.ownerCompanyId });
    if (!owner) return NextResponse.json({ error: 'A valid owner (admin, mentor or company) is required' }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      name: d.name,
      description: d.description || null,
      technologies: d.technologies ?? [],
      repoUrl: d.repoUrl || null,
      demoUrl: d.demoUrl || null,
      boardUrl: d.boardUrl || null,
      status: d.status ?? 'ACTIVE',
      isPublic: d.isPublic ?? false,
      goals: d.goals || null,
      startDate: d.startDate ? new Date(d.startDate) : null,
      endDate: d.endDate ? new Date(d.endDate) : null,
      ...owner,
    },
    include,
  });
  await logActivity({ action: 'project.create', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'project', targetId: project.id });
  return NextResponse.json({ project }, { status: 201 });
}
