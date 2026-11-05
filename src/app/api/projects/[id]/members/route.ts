import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { notify } from '@/lib/notify';
import { projectInCallerTenant } from '@/lib/projectAccess';
import { canManageProjectTeam, memberAddRefusal, nonManagerStatus } from '@/lib/projectTeamRule';
import { loadTeamConnections, loadTeamProject, loadTeamTarget } from '@/lib/projectTeamAccess';
import { withTenantScope } from '@/lib/orgContext';
import { requireCapability } from '@/lib/capabilityGate';
import { createOrGetProjectConversation, removeProjectConversationParticipant } from '@/lib/conversations';
import { notificationLink } from '@/lib/notificationLink';

// Person-level project membership management (#617): add/remove OWNERs,
// MENTORs and MENTEE contributors. Only an admin or a current OWNER — a mentee
// owner included (#2272) — may change the list, and the last OWNER can never
// be removed (no ownerless projects).

const addSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(['OWNER', 'MENTOR', 'MENTEE']).default('MENTOR'),
  functionalRole: z.enum(['DEVELOPER', 'TESTER', 'MARKETING']).nullable().optional(),
});
const removeSchema = z.object({ userId: z.string().min(1) });

// Who manages the roster and whom they may seat is ONE pure rule
// (`src/lib/projectTeamRule.ts`, #2272): `canManageProjectTeam()` and
// `memberAddRefusal()`. This route only loads the facts and answers. A caller
// who does not manage the team is refused by `nonManagerStatus()`.
function refuseNonManager(userId: string, project: { ownerUserId: string | null; members: { userId: string; role: string }[] }) {
  return nonManagerStatus(userId, project) === 403
    ? NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    : NextResponse.json({ error: 'Not found' }, { status: 404 });
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
    // Another tenant's project answers like a missing one (#2622).
    if (!(await projectInCallerTenant(session, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const project = await loadTeamProject(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canManageProjectTeam(session.user, project)) return refuseNonManager(session.user.id, project);
    const members = await prisma.projectMember.findMany({
      where: { projectId: id },
      orderBy: { addedAt: 'asc' },
      select: { role: true, functionalRole: true, addedAt: true, user: { select: { id: true, fullName: true, role: true } } },
    });
    return NextResponse.json({ members });
  });
}

// POST — add (or re-role) a member, within the actor's addable set (#2272).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const capGate = await requireCapability(session.user.orgId, 'projects');
  if (capGate) return capGate;
  return await withTenantScope(session, async () => {
    const { id } = await params;
    // Another tenant's project answers like a missing one (#2622).
    if (!(await projectInCallerTenant(session, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const project = await loadTeamProject(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canManageProjectTeam(session.user, project)) return refuseNonManager(session.user.id, project);

    const parsed = addSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const { userId, role } = parsed.data;
    // Functional role only applies to mentee members; ignore it for owners/mentors.
    const functionalRole = role === 'MENTEE' ? parsed.data.functionalRole ?? null : null;

    // Whom this actor may seat, and as what (#2272): an admin anyone active in
    // the tenant, a mentor any mentor/admin plus their own mentees, a mentee
    // owner only their own mentor(s) and those mentors' other mentees. The
    // target is read inside the caller's tenant (#2622), so another tenant's
    // person is a missing one — and so is anyone outside the actor's set.
    const target = await loadTeamTarget(session, userId);
    const connections = await loadTeamConnections(session);
    const refusal = memberAddRefusal(session.user, target, role, connections);
    if (refusal || !target) {
      return refusal?.code === 'wrong_seat'
        ? NextResponse.json(
            { error: 'A mentee joins as a mentee member; an owner or mentor member must be a mentor or admin', code: 'wrong_seat' },
            { status: 400 }
          )
        : NextResponse.json({ error: 'Not found', code: 'not_addable' }, { status: 404 });
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
  const capGate = await requireCapability(session.user.orgId, 'projects');
  if (capGate) return capGate;
  return await withTenantScope(session, async () => {
    const { id } = await params;
    // Another tenant's project answers like a missing one (#2622).
    if (!(await projectInCallerTenant(session, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const project = await loadTeamProject(id);
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!canManageProjectTeam(session.user, project)) return refuseNonManager(session.user.id, project);

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
