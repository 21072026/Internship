import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

/**
 * Fail-closed data scoping (#814 / #831).
 *
 * The API routes used to scope with "if I recognise the role, filter it" —
 * an `if/else if` chain with no final `else`. Any role the chain didn't name
 * (COMPANY, SOURCE, and every role added later) fell through with an empty
 * `where` and got ADMIN visibility. The helpers here invert that: a role with
 * no defined scope yields `null`, and the caller answers 403.
 */

/** Sentinel that can never match a cuid, used to force an empty result set. */
export const NO_MATCH = '__none__';

export interface ScopeUser {
  id: string;
  role: string;
  email?: string | null;
  companyId?: string | null;
}

/**
 * The source a SOURCE user represents. Mirrors `/api/source/mentees` — a SOURCE
 * account with no `sourceId` legitimately owns nothing, so it must see nothing.
 */
export async function sourceIdForUser(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { sourceId: true, role: true },
  });
  return u?.role === 'SOURCE' ? u.sourceId : null;
}

/**
 * Scope for anything reachable through a MentorshipRelation (the relations
 * themselves and their interaction logs). Returns `{}` for ADMIN — deliberately
 * unscoped — and `null` for a role with no defined scope, which the caller must
 * turn into a 403.
 */
export async function relationScopeForRole(
  user: ScopeUser
): Promise<Prisma.MentorshipRelationWhereInput | null> {
  switch (user.role) {
    case 'ADMIN':
      return {};
    case 'MENTOR':
      return { mentorId: user.id };
    case 'MENTEE':
      return { menteeId: user.id };
    case 'COMPANY':
      return { companyId: user.companyId ?? NO_MATCH };
    case 'SOURCE':
      return { mentee: { sourceId: (await sourceIdForUser(user.id)) ?? NO_MATCH } };
    default:
      return null;
  }
}

/** Audit a denial so an unscoped role showing up in production is visible. */
export async function logScopeDenial(user: ScopeUser, resource: string): Promise<void> {
  await logActivity({
    action: 'authz.scope_denied',
    level: 'warning',
    actorId: user.id,
    actorEmail: user.email ?? null,
    targetType: 'route',
    targetId: resource,
    detail: `No scope defined for role ${user.role}`,
  });
}
