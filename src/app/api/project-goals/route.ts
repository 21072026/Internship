import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';

// One person's project goals, across every project they are on.
//
// A goal assigned to someone is *their* goal, so it belongs on their profile
// rather than in the project's list where the whole team reads it (the project
// page keeps only the unassigned, claimable ones). This is the read side of that
// move: GET ?userId= — omit it for your own.
//
// Who may read whose:
//   - your own, always
//   - an ADMIN, anyone's
//   - a MENTOR, their own mentees' (an active or past mentorship is enough)
// Everything else is a 403, including "a colleague on the same project".

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  return await withTenantScope(session, async () => {
    const viewerId = session.user.id;
    const userId = new URL(request.url).searchParams.get('userId') || viewerId;

    if (userId !== viewerId && session.user.role !== 'ADMIN') {
      const mentorship = await prisma.mentorshipRelation.findFirst({
        where: { mentorId: viewerId, menteeId: userId },
        select: { id: true },
      });
      if (!mentorship) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [tasks, memberships] = await Promise.all([
      prisma.projectTask.findMany({
        where: { assigneeId: userId },
        orderBy: [{ done: 'asc' }, { order: 'asc' }],
        select: {
          id: true,
          title: true,
          done: true,
          doneAt: true,
          project: { select: { id: true, name: true, ownerUserId: true } },
        },
      }),
      // The viewer's own memberships decide whether they may tick a goal off —
      // mirroring PATCH /api/project-tasks/[taskId], which needs membership
      // plus either ownership of the goal or lead of the project.
      prisma.projectMember.findMany({
        where: { userId: viewerId },
        select: { projectId: true, role: true },
      }),
    ]);

    const memberOf = new Map(memberships.map((m) => [m.projectId, m.role]));
    const goals = tasks.map((task) => {
      const role = memberOf.get(task.project.id);
      const lead =
        session.user.role === 'ADMIN' || role === 'OWNER' || task.project.ownerUserId === viewerId;
      const canEdit = (lead || role !== undefined) && (lead || userId === viewerId);
      return {
        id: task.id,
        title: task.title,
        done: task.done,
        doneAt: task.doneAt,
        project: { id: task.project.id, name: task.project.name },
        canEdit,
      };
    });

    // Whether the viewer is looking at their own goals — the client offers
    // "release" (hand an unwanted goal back to the project) only there, the way
    // the project page used to for your own row.
    return NextResponse.json({ goals, viewerIsOwner: userId === viewerId });
  });
}
