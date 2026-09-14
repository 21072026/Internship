import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { withTenantScope } from '@/lib/orgContext';
import { createOrGetProjectConversation, removeProjectConversationParticipant } from '@/lib/conversations';
import { notificationLink } from '@/lib/notificationLink';

// Person-level project membership management (#617): add/remove OWNERs and
// MENTORs. Only an admin or a current OWNER may change the list, and the
// last OWNER can never be removed (no ownerless projects).

const addSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['OWNER', 'MENTOR', 'MENTEE']).default('MENTOR'),
  functionalRole: z.enum(['DEVELOPER', 'TESTER', 'MARKETING']).nullable().optional(),
});
const removeSchema = z.object({ userId: z.string().min(1) });

async function loadContext(id: string) {
  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, ownerUserId: true, members: { select: { userId: true, role: true } } },
  });
  return project;
}

// Same test as `isProjectOwner()` (lib/projectAccess.ts), spelled out against
// the already-loaded context instead of re-querying: an admin, an OWNER member,
// or the legacy `ownerUserId` pointer. That last arm is not decoration — a
// project whose OWNER member row was never backfilled (the demo set seeds
// `ownerUserId` alone, and neither topic-deploy.sh nor demo-refresh.sh runs
// backfill-project-members.mjs) still has a real owner, and /projects/[id]
// derives `isLead` from exactly that pointer. Leaving it out rendered the
// members panel for an owner whose every request to it answered 403.
function canManageMembers(
  user: { id: string; role: string },
  project: { ownerUserId: string | null; members: { userId: string; role: string }[] }
) {
  if (user.role === 'ADMIN') return true;
  if (project.ownerUserId && project.ownerUserId === user.id) return true;
  return project.members.some((m) => m.userId === user.id && m.role === 'OWNER');
}

// GET — this project's roster, for the people who manage it. The guard used to
// be "any signed-in user who is not a MENTEE" (#2270), which was wrong twice: it
// let any mentor or company account read any project's roster (names, roles, user
// ids), and it locked a MENTEE **owner** out of their own project's member list.
// Same test as every other write here: an admin, or an OWNER of this project.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const project = await loadContext(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canManageMembers(session.user, project)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const members = await prisma.projectMember.findMany({
      where: { projectId: id },
      orderBy: { addedAt: 'asc' },
      select: { role: true, functionalRole: true, addedAt: true, user: { select: { id: true, fullName: true, role: true } } },
    });
    return NextResponse.json({ members });
  });
}

// POST — add (or re-role) a member. Target must be an active MENTOR or ADMIN.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const project = await loadContext(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canManageMembers(session.user, project)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    // A MENTEE owner does not add people directly (#2270). `canManageMembers`
    // is role-blind, so opening self-service creation would otherwise let the
    // lowest-privilege role add any active mentee in the tenant — with no
    // relation check, a notification and a seat in the project group chat each
    // time. They grow their team through the join-request flow instead
    // ([id]/join-requests), which the applicant starts — but only once the
    // project is public, since a private one answers `not_public` to every
    // request. A mentee-created project starts private and only an admin can
    // publish it, so the message has to name that step: pointing them at join
    // requests alone described a flow they could not reach.
    if (session.user.role === 'MENTEE') {
      return NextResponse.json(
        {
          error:
            'Approve a join request to add someone to your project — ask an admin to publish it to the showcase, or to add someone for you while it is private',
          code: 'mentee_owner_invite',
        },
        { status: 403 }
      );
    }

    const parsed = addSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { userId, role } = parsed.data;
    // Functional role only applies to mentee members; ignore it for owners/mentors.
    const functionalRole = role === 'MENTEE' ? parsed.data.functionalRole ?? null : null;

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isActive: true } });
    if (!target || !target.isActive) {
      return NextResponse.json({ error: 'Member must be an active user' }, { status: 400 });
    }
    // Structural role must match who the person is: mentees join as MENTEE
    // (contributors), mentors/admins as OWNER or MENTOR.
    if (role === 'MENTEE') {
      if (target.role !== 'MENTEE') {
        return NextResponse.json({ error: 'Only a mentee can be added as a mentee member' }, { status: 400 });
      }
    } else if (target.role !== 'MENTOR' && target.role !== 'ADMIN') {
      return NextResponse.json({ error: 'An owner or mentor member must be an active mentor or admin' }, { status: 400 });
    }

    if (session.user.role === 'MENTOR' && role === 'MENTEE') {
      const relation = await prisma.mentorshipRelation.findFirst({
        where: { mentorId: session.user.id, menteeId: userId },
        select: { id: true },
      });
      if (!relation) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Demoting the last OWNER to a non-owner role would leave the project ownerless.
    const owners = project.members.filter((m) => m.role === 'OWNER');
    if (role !== 'OWNER' && owners.length === 1 && owners[0].userId === userId) {
      return NextResponse.json({ error: 'A project must keep at least one owner', code: 'last_owner' }, { status: 409 });
    }

    const member = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: id, userId } },
      update: { role, functionalRole },
      create: { projectId: id, userId, role, functionalRole },
      select: { role: true, functionalRole: true, user: { select: { id: true, fullName: true } } },
    });
    await createOrGetProjectConversation(id);
    if (userId !== session.user.id) {
      await notify(userId, 'project.memberAdded', { project: project.name }, notificationLink(target.role, 'project', { projectId: id }));
    }
    await logActivity({ action: 'project.member_add', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'project', targetId: id, detail: `${userId} as ${role}` });
    return NextResponse.json({ member }, { status: 201 });
  });
}

// DELETE — remove a member; the last OWNER is protected.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return await withTenantScope(session, async () => {
    const { id } = await params;
    const project = await loadContext(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canManageMembers(session.user, project)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const parsed = removeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { userId } = parsed.data;

    const existing = project.members.find((m) => m.userId === userId);
    if (!existing) return NextResponse.json({ error: 'Not a member' }, { status: 404 });

    const owners = project.members.filter((m) => m.role === 'OWNER');
    if (existing.role === 'OWNER' && owners.length === 1) {
      return NextResponse.json({ error: 'A project must keep at least one owner', code: 'last_owner' }, { status: 409 });
    }

    await prisma.projectMember.delete({ where: { projectId_userId: { projectId: id, userId } } });
    await removeProjectConversationParticipant(id, userId);

    // Keep the legacy single-owner pointer valid: if the removed user was the
    // legacy owner, repoint it at a remaining OWNER member.
    if (project.ownerUserId === userId) {
      const nextOwner = owners.find((o) => o.userId !== userId);
      if (nextOwner) {
        const nextUser = await prisma.user.findUnique({ where: { id: nextOwner.userId }, select: { role: true } });
        // ownerType follows who the successor actually is (#2270). The old
        // two-way ternary wrote 'MENTOR' for a mentee successor, producing a row
        // `resolveOwner()` would reject and that ProjectOwnerType contradicts.
        const ownerType =
          nextUser?.role === 'ADMIN' ? 'ADMIN' : nextUser?.role === 'MENTEE' ? 'MENTEE' : 'MENTOR';
        await prisma.project.update({
          where: { id },
          data: { ownerUserId: nextOwner.userId, ownerType },
        });
      }
    }

    await logActivity({ action: 'project.member_remove', actorId: session.user.id, actorEmail: session.user.email ?? null, targetType: 'project', targetId: id, detail: userId });
    return NextResponse.json({ ok: true });
  });
}
