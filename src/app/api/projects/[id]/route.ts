import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { canViewProject, canManageProject, resolveOwner } from '@/lib/projectAccess';
import { logActivity } from '@/lib/activity';

const include = {
  ownerUser: { select: { id: true, fullName: true, role: true } },
  ownerCompany: { select: { id: true, name: true } },
  relations: {
    select: { id: true, pipelineStatus: true, mentee: { select: { id: true, fullName: true } }, mentor: { select: { fullName: true } } },
  },
  tasks: { orderBy: { order: 'asc' } },
} as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id }, include });
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canViewProject(session.user, project)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json({ project });
}

const schema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  technologies: z.array(z.string()).max(50).optional(),
  repoUrl: z.string().url().max(500).optional().or(z.literal('')),
  demoUrl: z.string().url().max(500).optional().or(z.literal('')),
  boardUrl: z.string().url().max(500).optional().or(z.literal('')),
  status: z.enum(['DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED', 'CANCELLED']).optional(),
  isPublic: z.boolean().optional(),
  goals: z.string().max(5000).nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  // Owner change (transfer) — admin only.
  ownerType: z.enum(['ADMIN', 'MENTOR', 'COMPANY']).optional(),
  ownerUserId: z.string().nullable().optional(),
  ownerCompanyId: z.string().nullable().optional(),
});

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canManageProject(session.user, project)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const data: Record<string, unknown> = {};
  if (d.name !== undefined) data.name = d.name;
  if (d.description !== undefined) data.description = d.description || null;
  if (d.technologies !== undefined) data.technologies = d.technologies;
  if (d.repoUrl !== undefined) data.repoUrl = d.repoUrl || null;
  if (d.demoUrl !== undefined) data.demoUrl = d.demoUrl || null;
  if (d.boardUrl !== undefined) data.boardUrl = d.boardUrl || null;
  if (d.status !== undefined) data.status = d.status;
  if (d.isPublic !== undefined) data.isPublic = d.isPublic;
  if (d.goals !== undefined) data.goals = d.goals || null;
  if (d.startDate !== undefined) data.startDate = d.startDate ? new Date(d.startDate) : null;
  if (d.endDate !== undefined) data.endDate = d.endDate ? new Date(d.endDate) : null;

  // Transfer (admin only): change the owner, preserving the invariant.
  let transferred: string | null = null;
  if (d.ownerType && session.user.role === 'ADMIN') {
    // For ADMIN ownership default to the acting admin when no specific user is
    // given (the UI has no admin picker), so a transfer to "Admin (me)" works
    // even if the client didn't send an id.
    const ownerUserId = d.ownerType === 'ADMIN' ? d.ownerUserId || session.user.id : d.ownerUserId;
    const owner = await resolveOwner({ ownerType: d.ownerType, ownerUserId, ownerCompanyId: d.ownerCompanyId });
    if (!owner) return NextResponse.json({ error: 'Invalid owner' }, { status: 400 });
    Object.assign(data, owner);
    transferred = `${project.ownerType} → ${owner.ownerType}`;
  }

  const updated = await prisma.project.update({ where: { id }, data, include });
  if (transferred) {
    await logActivity({ action: 'project.transfer', level: 'warning', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'project', targetId: id, detail: transferred });
  }
  return NextResponse.json({ project: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!canManageProject(session.user, project)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Detach mentees, then delete.
  await prisma.mentorshipRelation.updateMany({ where: { projectId: id }, data: { projectId: null } });
  await prisma.project.delete({ where: { id } });
  await logActivity({ action: 'project.delete', level: 'warning', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'project', targetId: id });
  return NextResponse.json({ ok: true });
}
