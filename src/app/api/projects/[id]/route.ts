import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { canViewProject, resolveOwner, isProjectOwner, isProjectMember } from '@/lib/projectAccess';
import { logActivity } from '@/lib/activity';
import { withTenantScope } from '@/lib/orgContext';

const include = {
  ownerUser: { select: { id: true, fullName: true, role: true } },
  ownerCompany: { select: { id: true, name: true } },
  relations: {
    select: { id: true, pipelineStatus: true, mentee: { select: { id: true, fullName: true } }, mentor: { select: { fullName: true } } },
  },
  tasks: { orderBy: { order: 'asc' } },
  members: {
    orderBy: { addedAt: 'asc' },
    select: { role: true, functionalRole: true, addedAt: true, user: { select: { id: true, fullName: true, role: true } } },
  },
} as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id }, include });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canViewProject(session.user, project)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return NextResponse.json({ project });
  });
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
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Owner-only fields (#619): owners (admin / OWNER member / legacy owner)
    // edit everything; other MENTOR members only the collaborative fields.
    const owner = await isProjectOwner(session.user, id);
    const member = owner || (session.user.role === 'MENTOR' && (await isProjectMember(session.user, id)));
    if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
    const d = parsed.data;

    if (!owner) {
      const protectedSent = (['name', 'status', 'isPublic', 'startDate', 'endDate', 'ownerType', 'ownerUserId', 'ownerCompanyId'] as const)
        .filter((k) => d[k] !== undefined);
      if (protectedSent.length > 0) {
        return NextResponse.json(
          { error: 'Only a project owner may change these fields', fields: protectedSent, code: 'owner_only' },
          { status: 403 }
        );
      }
    }

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
    // Keep the members table in step with a legacy transfer (#617): the new
    // person owner becomes (or stays) an OWNER member. Previous owners keep
    // their rows — multi-owner is allowed; removal goes through /members.
    if (transferred && typeof data.ownerUserId === 'string') {
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: id, userId: data.ownerUserId } },
        update: { role: 'OWNER' },
        create: { projectId: id, userId: data.ownerUserId, role: 'OWNER' },
      });
    }
    if (transferred) {
      await logActivity({ action: 'project.transfer', level: 'warning', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'project', targetId: id, detail: transferred });
    }
    return NextResponse.json({ project: updated });
  });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Deletion is owner-only (#619).
    if (!(await isProjectOwner(session.user, id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Detach mentees, then delete.
    await prisma.mentorshipRelation.updateMany({ where: { projectId: id }, data: { projectId: null } });
    await prisma.project.delete({ where: { id } });
    await logActivity({ action: 'project.delete', level: 'warning', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'project', targetId: id });
    return NextResponse.json({ ok: true });
  });
}
