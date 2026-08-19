import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { withTenantScope } from '@/lib/orgContext';
import { isProjectOwner } from '@/lib/projectAccess';
import { createOrGetProjectConversation } from '@/lib/conversations';
import { sendProjectJoinRequestEmail } from '@/services/emailService';

// Requests to join a project (#51). Only *public* projects accept them — a
// private project is not advertised, so asking to join one is meaningless. The
// project's owners (and any admin) decide; approving is what creates the
// ProjectMember row, with the functional role the applicant asked for.

const createSchema = z.object({
  message: z.string().max(2000).optional(),
  functionalRole: z.enum(['DEVELOPER', 'TESTER', 'MARKETING']).optional(),
});

const decideSchema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(['APPROVED', 'REJECTED']),
  functionalRole: z.enum(['DEVELOPER', 'TESTER', 'MARKETING']).nullable().optional(),
  note: z.string().max(2000).optional(),
});

const requestSelect = {
  id: true,
  status: true,
  message: true,
  functionalRole: true,
  createdAt: true,
  decidedAt: true,
  decisionNote: true,
  user: { select: { id: true, fullName: true, email: true, role: true, university: true, department: true } },
} as const;

// GET — the pending/decided requests. An owner or admin sees the whole list; any
// other signed-in user sees only their own (so the UI can say "pending").
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const manage = await isProjectOwner(session.user, id);
    const requests = await prisma.projectJoinRequest.findMany({
      where: { projectId: id, ...(manage ? {} : { userId: session.user.id }) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      select: requestSelect,
    });
    return NextResponse.json({ requests, canManage: manage });
  });
}

// POST — ask to join. Idempotent per person: a second call updates the existing
// row (and a previously declined request can be re-submitted).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const project = await prisma.project.findUnique({
      where: { id },
      select: { id: true, name: true, isPublic: true, status: true, orgId: true },
    });
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!project.isPublic) {
      return NextResponse.json({ error: 'This project is not open to join requests', code: 'not_public' }, { status: 403 });
    }

    const already = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: id, userId: session.user.id } },
      select: { id: true },
    });
    if (already) return NextResponse.json({ error: 'Already a member', code: 'already_member' }, { status: 409 });

    const parsed = createSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });

    const joinRequest = await prisma.projectJoinRequest.upsert({
      where: { projectId_userId: { projectId: id, userId: session.user.id } },
      update: {
        message: parsed.data.message || null,
        functionalRole: parsed.data.functionalRole ?? null,
        status: 'PENDING',
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
      },
      create: {
        projectId: id,
        userId: session.user.id,
        message: parsed.data.message || null,
        functionalRole: parsed.data.functionalRole ?? null,
      },
      select: requestSelect,
    });

    // Tell the people who can act on it: OWNER members (+ the legacy owner
    // pointer) and every active admin.
    const [owners, admins] = await Promise.all([
      prisma.projectMember.findMany({
        where: { projectId: id, role: 'OWNER' },
        select: { user: { select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true } } },
      }),
      prisma.user.findMany({
        where: { role: 'ADMIN', isActive: true },
        select: { id: true, email: true, fullName: true, emailNotifications: true, notificationPrefs: true },
      }),
    ]);
    const recipients = [...owners.map((o) => o.user), ...admins].filter(
      (u, i, all) => u.id !== session.user.id && all.findIndex((o) => o.id === u.id) === i
    );
    await Promise.all(
      recipients.map((r) =>
        notify(r.id, 'project.joinRequested', { from: joinRequest.user.fullName, project: project.name }, `/projects/${id}`)
      )
    );
    for (const r of recipients) {
      try {
        await sendProjectJoinRequestEmail({
          to: r.email,
          fullName: r.fullName,
          projectId: id,
          projectName: project.name,
          requesterName: joinRequest.user.fullName,
          message: joinRequest.message,
          recipient: r,
          orgId: project.orgId,
        });
      } catch (e) {
        console.error('Join request email failed:', e);
      }
    }

    await logActivity({
      action: 'project.join_request',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'project',
      targetId: id,
    });
    return NextResponse.json({ request: joinRequest }, { status: 201 });
  });
}

// PATCH — approve or decline. Approving adds the ProjectMember row (and pulls the
// person into the project's group chat), so the owner never has to do it twice.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    if (!(await isProjectOwner(session.user, id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const parsed = decideSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
    const { requestId, decision, note } = parsed.data;

    const existing = await prisma.projectJoinRequest.findUnique({
      where: { id: requestId },
      select: { id: true, projectId: true, userId: true, functionalRole: true, user: { select: { role: true } } },
    });
    if (!existing || existing.projectId !== id) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const project = await prisma.project.findUnique({ where: { id }, select: { name: true } });
    const functionalRole = parsed.data.functionalRole ?? existing.functionalRole ?? null;

    if (decision === 'APPROVED') {
      // Structural role follows who the person is, exactly like the member panel:
      // a mentee joins as a MENTEE contributor, a mentor/admin as a MENTOR.
      const structural = existing.user.role === 'MENTEE' ? 'MENTEE' : 'MENTOR';
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: id, userId: existing.userId } },
        update: { role: structural, functionalRole: structural === 'MENTEE' ? functionalRole : null },
        create: {
          projectId: id,
          userId: existing.userId,
          role: structural,
          functionalRole: structural === 'MENTEE' ? functionalRole : null,
        },
      });
      await createOrGetProjectConversation(id);
    }

    // A double-clicked Approve (or a request withdrawn in between) would
    // otherwise surface as a 500 from Prisma's P2025.
    let updated;
    try {
      updated = await prisma.projectJoinRequest.update({
        where: { id: requestId },
        data: {
          status: decision,
          functionalRole,
          decidedById: session.user.id,
          decidedAt: new Date(),
          decisionNote: note || null,
        },
        select: requestSelect,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      throw e;
    }

    await notify(
      existing.userId,
      decision === 'APPROVED' ? 'project.joinApproved' : 'project.joinRejected',
      { project: project?.name ?? '' },
      `/projects/${id}`
    );
    await logActivity({
      action: decision === 'APPROVED' ? 'project.join_approved' : 'project.join_rejected',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'project',
      targetId: id,
      detail: existing.userId,
    });
    return NextResponse.json({ request: updated });
  });
}
