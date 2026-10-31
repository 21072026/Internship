// A goal's sub-tasks and its pooled wording (#1860). Pure — no Prisma, no
// session — so the routes, the panel and the unit test share one answer.
//
// A goal's sub-tasks ARE to-dos (ProjectTask with `goalId`): they appear on
// the assignee's /todos list and tick there too. A goal's progress is DERIVED
// from them once it has any — ticking a step on /todos moves the bar — and the
// hand-entered figure (#1858) is the answer only for a goal without steps.

export interface SubtaskState {
  done: boolean;
}

/** The progress a goal shows: derived from its steps when it has any, else the manual figure. */
export function derivedGoalProgress(manual: number | null, subtasks: readonly SubtaskState[]): number | null {
  if (subtasks.length === 0) return manual;
  const done = subtasks.filter((s) => s.done).length;
  return Math.round((done / subtasks.length) * 100);
}

export interface PooledGoal {
  templateId: string | null;
  createdById: string | null;
}

/**
 * A goal from the shared pool keeps the pool's wording: nobody rewords it on
 * the goal (it is reworded in the pool, and reaches everyone it was given to).
 */
export function canRewordGoal(goal: PooledGoal): boolean {
  return goal.templateId === null;
}

/**
 * Deleting: a hand-written goal, any participant who may see it (as before);
 * a pooled one only whoever handed it out, or an admin — the person it was
 * given to cannot make it disappear, the same rule as a pooled to-do.
 */
export function canDeleteGoal(goal: PooledGoal, viewer: { id: string; isAdmin: boolean }): boolean {
  if (goal.templateId === null) return true;
  return viewer.isAdmin || goal.createdById === viewer.id;
}

export interface SubtaskRow {
  templateId: string | null;
  createdById: string | null;
  assigneeId: string | null;
}

/**
 * What a reader of the goal may do with one of its steps — the same answer
 * PATCH/DELETE /api/project-tasks/[taskId] gives, because a step IS a to-do.
 * Every reader of the goal may tick it (it is the pair's shared plan); its
 * author or an admin rewords it (never a pooled one) and deletes it; the
 * person it is assigned to may delete a hand-written one, as on /todos.
 */
export function subtaskPermissions(task: SubtaskRow, viewer: { id: string; isAdmin: boolean }) {
  const lead = task.createdById === viewer.id || viewer.isAdmin;
  const pooled = task.templateId !== null;
  return {
    canCheck: true,
    canEdit: lead && !pooled,
    canDelete: lead || (!pooled && task.assigneeId === viewer.id),
  };
}
