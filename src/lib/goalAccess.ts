import { prisma } from '@/lib/prisma';
import { inCallerTenant } from '@/lib/tenantFilter';
import { canReachGoals, canReadGoal } from '@/lib/goalVisibilityRule';

// One goal, if the caller may read it. Shared by /api/goals/[id] and its
// sub-tasks route (#1860), so the two cannot answer differently.
//
// 'missing' covers another tenant's goal too (#2542): Goal has no orgId, the
// nested relation include is never scoped, so the tenant is checked here, and
// the answer is the 404 a missing id gets — a 403 would confirm the id exists.
// A PRIVATE goal of someone else (#1858) gets the same 'missing' for the same
// reason: the other side must not learn that a goal they cannot read exists.
export async function goalIfAllowed(userId: string, role: string, goalId: string, callerOrgId: string | null) {
  const goal = await prisma.goal.findUnique({ where: { id: goalId }, include: { relation: true } });
  if (!goal || !(await inCallerTenant(goal.relation.orgId, callerOrgId))) return 'missing' as const;
  const viewer = { id: userId, role };
  if (!canReachGoals(goal.relation, viewer)) return null;
  return canReadGoal(goal, goal.relation, viewer) ? goal : ('missing' as const);
}

/** Neither side of the pair, yet reaches its goals: the programme's admin. Not a role-string check (#1571). */
export function readsAsAdmin(rel: { mentorId: string; menteeId: string }, userId: string): boolean {
  return rel.mentorId !== userId && rel.menteeId !== userId;
}
