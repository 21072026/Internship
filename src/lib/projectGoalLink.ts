/**
 * Where a person reads a to-do that was just assigned to them.
 *
 * Everyone has one to-do list now (`/todos`): what a mentor handed them, what
 * came with a project and what they wrote for themselves, in one place (#1113).
 * This used to send mentees to their profile and everyone else to the project
 * page — two destinations for the same kind of row, which is the split the to-do
 * page replaced. Still async so callers (and their tests) stay unchanged.
 */
export async function goalLinkFor(_assigneeId: string, _projectId?: string | null): Promise<string> {
  return '/todos';
}
