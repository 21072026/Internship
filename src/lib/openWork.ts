import { prisma } from '@/lib/prisma';

// "Nothing open" is not a goals-only question (#1113 to-dos): a mentor hands
// work out from the shared pool as ProjectTasks, not as Goal rows, so a mentee
// with four open to-dos and no Goal was still flagged "no open goal". Count the
// to-dos the mentor can actually see on that mentee's list — the ones a project
// or another person put there, which is exactly the filter GET /api/todos
// applies when reading somebody else's list; a line the mentee wrote for
// themselves is private and stays out of this.
//
// Shared by the mentor attention queue and the nightly health sweep (#1901),
// so "has open work" means one thing.
export async function menteesWithOpenTodo(menteeIds: string[]): Promise<Set<string>> {
  if (menteeIds.length === 0) return new Set();
  const openTodos = await prisma.projectTask.findMany({
    where: { assigneeId: { in: menteeIds }, done: false, archivedAt: null },
    select: { assigneeId: true, projectId: true, createdById: true },
  });
  return new Set(
    openTodos.filter((t) => t.projectId !== null || t.createdById !== t.assigneeId).map((t) => t.assigneeId as string),
  );
}
