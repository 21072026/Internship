import { prisma } from '@/lib/prisma';

/**
 * Where a person reads a project goal that was just assigned to them.
 *
 * A personal goal is no longer listed on the project page — it lives on the
 * assignee's own profile — so a notification pointing at `/projects/<id>` would
 * send them somewhere the goal is not. Mentees read theirs in the portal; anyone
 * else (a mentor or admin who ended up with a goal) still manages the project
 * itself, so the project page is the useful destination for them.
 */
export async function goalLinkFor(assigneeId: string, projectId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: assigneeId }, select: { role: true } });
  return user?.role === 'MENTEE' ? '/portal/profile' : `/projects/${projectId}`;
}
