// Whose to-do somebody else may read (#1113, #2440).
//
// One sentence, and by now three readers: **a line somebody wrote for
// themselves on their own list stays theirs.** Everything else on a person's
// list came from a project or from another person, and whoever may reach that
// list may read it.
//
// /api/todos says it in SQL when it opens ONE person's list, because there the
// owner is known: `OR: [{ projectId: { not: null } }, { createdById: { not:
// ownerId } }]`. The two readers that span MANY owners cannot — the comparison
// is between two columns of the same row — so they say it here instead, once:
//
//   - the team list (`?scope=team`), which is a mentor's mentees or an admin's
//     whole organisation;
//   - the overdue block of the daily activity digest, which mails those same
//     people's late to-dos to their mentor and to every admin.
//
// The digest is the reason this module exists rather than a second copy of the
// filter: a private line that no page will show is not a line an e-mail may
// carry either, and a mail is the widest reading of all.
//
// Dependency-free on purpose (no Prisma, no i18n): it takes the three columns
// that decide the answer and nothing else, so the rule can be unit-tested and
// both call sites provably run the same one.

/** The three columns of a to-do that decide who may read it. */
export interface TodoOwnership {
  /** Non-null = it belongs to a project, and a project's work is the team's. */
  projectId: string | null;
  /** Who put it on the list. Null = nobody recorded, which is not "themselves". */
  createdById: string | null;
  /** Whose list it is on. */
  assigneeId: string | null;
}

/**
 * A line somebody wrote for themselves on their own list — private to its
 * owner, and the one thing a visitor to that list never sees.
 *
 * Mirrors the SQL form exactly, including its treatment of a missing author: a
 * row with no `createdById` is NOT self-written (`createdById: { not: ownerId }`
 * matches it in Prisma), so it stays visible.
 */
export function isPrivateSelfTodo(row: TodoOwnership): boolean {
  return row.projectId === null && row.createdById !== null && row.createdById === row.assigneeId;
}

/**
 * The rows of a many-owner list that `viewerId` may read: everything of their
 * own, and everybody else's minus their private lines.
 */
export function visibleToViewer<T extends TodoOwnership>(
  rows: readonly T[],
  viewerId: string
): T[] {
  return rows.filter((row) => row.assigneeId === viewerId || !isPrivateSelfTodo(row));
}
