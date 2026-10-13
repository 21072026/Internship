// ---------------------------------------------------------------------------
// Who may read a Goal (#1858).
//
// A goal's `visibility` is AUTHORIZATION, not presentation: hiding a card in
// GoalsPanel is not a check. Every goal route — GET /api/goals, PATCH/DELETE
// /api/goals/[id], the relation timeline — answers through this module, so a
// future route cannot forget the rule by not knowing it exists.
//
//   PAIR     (default) the two participants of the mentorship, and the
//            programme's admins — exactly who could reach every goal before
//            the column existed, so nothing already written changes reach.
//   PROGRAM  the same readers, plus the participant's explicit consent to the
//            goal appearing on programme-level surfaces (reports, the journey
//            view) rather than only on the pairing's own pages.
//   PRIVATE  the author alone. Not the other side, not an admin. A route
//            answers for it exactly as for a goal that does not exist.
//
// The author is `createdById`; rows older than that column fall back to
// `createdByRole` (the mentor or the mentee of the relation). A goal that has
// no resolvable author cannot be PRIVATE through the API — PATCH stamps
// `createdById` the moment the author narrows it — so the "no author, PRIVATE"
// branch below is only the safe answer for a hand-edited row: nobody.
//
// Deliberately dependency-free (no Prisma import): the portal and the panel
// import it for the option list, and `scripts/test/goal-visibility.test.mjs`
// runs it under node --test with no build step.
// ---------------------------------------------------------------------------

export const GOAL_VISIBILITIES = ['PAIR', 'PROGRAM', 'PRIVATE'] as const;
export type GoalVisibility = (typeof GOAL_VISIBILITIES)[number];
export const DEFAULT_GOAL_VISIBILITY: GoalVisibility = 'PAIR';

export function isGoalVisibility(value: unknown): value is GoalVisibility {
  return typeof value === 'string' && (GOAL_VISIBILITIES as readonly string[]).includes(value);
}

/** The columns of a Goal the rule reads. */
export interface GoalScope {
  visibility: string;
  createdById: string | null;
  createdByRole: string | null;
}

/** The two seats of the mentorship the goal hangs off. */
export interface GoalRelationSeats {
  mentorId: string;
  menteeId: string;
}

/** Who is asking. `role` is the global role; ADMIN reaches every pairing of its tenant. */
export interface GoalViewer {
  id: string;
  role: string;
}

/** Progress is a whole percentage; anything else is refused by the routes. */
export const GOAL_PROGRESS_MIN = 0;
export const GOAL_PROGRESS_MAX = 100;

/**
 * The one reader of a PRIVATE goal. `createdById` when the row has it,
 * otherwise the seat `createdByRole` names; null when neither says.
 */
export function goalAuthorId(goal: Pick<GoalScope, 'createdById' | 'createdByRole'>, rel: GoalRelationSeats): string | null {
  if (goal.createdById) return goal.createdById;
  if (goal.createdByRole === 'MENTOR') return rel.mentorId;
  if (goal.createdByRole === 'MENTEE') return rel.menteeId;
  return null;
}

export function isGoalParticipant(rel: GoalRelationSeats, viewer: Pick<GoalViewer, 'id'>): boolean {
  return viewer.id === rel.mentorId || viewer.id === rel.menteeId;
}

/** Can this viewer reach the relation's goals at all (before visibility)? */
export function canReachGoals(rel: GoalRelationSeats, viewer: GoalViewer): boolean {
  return viewer.role === 'ADMIN' || isGoalParticipant(rel, viewer);
}

/**
 * May `viewer` read `goal`? False means the route answers as for a goal that
 * does not exist — never a 403 that would confirm the id.
 */
export function canReadGoal(goal: GoalScope, rel: GoalRelationSeats, viewer: GoalViewer): boolean {
  if (!canReachGoals(rel, viewer)) return false;
  if (goal.visibility === 'PRIVATE') {
    const author = goalAuthorId(goal, rel);
    return author !== null && author === viewer.id;
  }
  // PAIR, PROGRAM and any value the column has never been given.
  return true;
}

/** The rows of `goals` that `viewer` may see, in the order given. */
export function visibleGoals<T extends GoalScope>(goals: readonly T[], rel: GoalRelationSeats, viewer: GoalViewer): T[] {
  return goals.filter((g) => canReadGoal(g, rel, viewer));
}

/**
 * The same rule as a Prisma `where` fragment, for readers that page in SQL
 * (the relation timeline) and cannot filter after the fact without breaking
 * their cursor. Only valid once `canReachGoals` has passed — it narrows the
 * PRIVATE rows to the viewer's own, which is all the SQL side needs because
 * a PRIVATE row always carries `createdById` (see the header).
 */
export function readableGoalsWhere(viewer: Pick<GoalViewer, 'id'>): { OR: Array<Record<string, unknown>> } {
  return { OR: [{ visibility: { not: 'PRIVATE' } }, { createdById: viewer.id }] };
}

/**
 * May `viewer` change the goal's sharing scope? Only its author: a mentor who
 * set a goal for the mentee decides who else reads it, and vice versa. A goal
 * whose author cannot be resolved keeps the scope it has.
 */
export function canSetGoalVisibility(goal: GoalScope, rel: GoalRelationSeats, viewer: GoalViewer): boolean {
  if (!canReadGoal(goal, rel, viewer)) return false;
  const author = goalAuthorId(goal, rel);
  return author !== null && author === viewer.id;
}
