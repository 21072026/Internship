import { prisma } from '@/lib/prisma';
import { isPrivateSelfTodo } from '@/lib/todoVisibility';

// "Has this mentee got open development work?" — ONE answer (#1860), shared by
// the mentor attention queue and the nightly health sweep (#1901), so "no open
// goal" means one thing everywhere. Open work on a relation is any of:
//
//   - an OPEN goal of the relation;
//   - an open, unarchived step of one of its goals (a ProjectTask with
//     `goalId`, #1860) — a goal's steps are the pair's shared plan, so a step
//     counts whoever wrote it;
//   - an open, unarchived to-do on the mentee's list that the mentor can see —
//     one a project or another person put there (#1113). A line the mentee
//     wrote for themselves is private (src/lib/todoVisibility.ts) and stays out.
//
// Goals and to-dos stay two models bridged by a nullable FK, never merged
// (`db push`, #1515) — this is where they meet.
export async function relationsWithOpenWork(rows: readonly { id: string; menteeId: string }[]): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const relationIds = rows.map((r) => r.id);
  const [goals, steps, todos] = await Promise.all([
    prisma.goal.findMany({ where: { relationId: { in: relationIds }, status: 'OPEN' }, select: { relationId: true } }),
    prisma.projectTask.findMany({
      where: { goal: { relationId: { in: relationIds } }, done: false, archivedAt: null },
      select: { goal: { select: { relationId: true } } },
    }),
    prisma.projectTask.findMany({
      where: { assigneeId: { in: rows.map((r) => r.menteeId) }, done: false, archivedAt: null },
      select: { assigneeId: true, projectId: true, createdById: true },
    }),
  ]);
  const open = new Set<string>([...goals.map((g) => g.relationId), ...steps.flatMap((s) => (s.goal ? [s.goal.relationId] : []))]);
  const menteesWithTodo = new Set(todos.filter((t) => !isPrivateSelfTodo(t)).map((t) => t.assigneeId as string));
  for (const r of rows) if (menteesWithTodo.has(r.menteeId)) open.add(r.id);
  return open;
}
