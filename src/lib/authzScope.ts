import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

/**
 * Fail-closed data scoping (#814 / #831 / #849).
 *
 * The API routes used to scope with "if I recognise the role, filter it" —
 * an `if/else if` chain with no final `else`. Any role the chain didn't name
 * (COMPANY, SOURCE, and every role added later) fell through with an empty
 * `where` and got ADMIN visibility. `scopeForRole()` inverts that: every role
 * needs an entry, a role without one yields `null`, and the caller answers 403.
 *
 * Adding a role to `Role` in schema.prisma without adding it to the builders
 * below now costs that role its access — it never silently grants it.
 *
 *     const scope = await scopeForRole(session.user, 'relation');
 *     if (!scope) {
 *       await logScopeDenial(session.user, 'GET /api/thing');
 *       return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
 *     }
 */

/** Sentinel that can never match a cuid, used to force an empty result set. */
export const NO_MATCH = '__none__';

export interface ScopeUser {
  id: string;
  role: string;
  email?: string | null;
  companyId?: string | null;
}

/** The `where` shape each scoped resource expects. */
export interface ScopeMap {
  /** MentorshipRelation itself, and anything reached through it (interaction logs). */
  relation: Prisma.MentorshipRelationWhereInput;
  project: Prisma.ProjectWhereInput;
}

export type ScopedResource = keyof ScopeMap;

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
 * One builder per role, per resource. `{}` means "deliberately unscoped"
 * (ADMIN); a missing key means "no scope defined" and denies the role.
 */
const BUILDERS: {
  [K in ScopedResource]: Partial<Record<string, (user: ScopeUser) => Promise<ScopeMap[K]>>>;
} = {
  relation: {
    // Admins see the whole tenant by design.
    ADMIN: async () => ({}),
    MENTOR: async (u) => ({ mentorId: u.id }),
    MENTEE: async (u) => ({ menteeId: u.id }),
    // Read-only: only relations linked to this company.
    COMPANY: async (u) => ({ companyId: u.companyId ?? NO_MATCH }),
    // Only the mentees this source referred.
    SOURCE: async (u) => ({ mentee: { sourceId: (await sourceIdForUser(u.id)) ?? NO_MATCH } }),
  },
  project: {
    ADMIN: async () => ({}),
    // Mentors see projects they own OR are members of (#617/#619).
    MENTOR: async (u) => ({
      OR: [{ ownerUserId: u.id }, { members: { some: { userId: u.id } } }],
    }),
    MENTEE: async () => ({ isPublic: true }),
    COMPANY: async (u) => ({ ownerCompanyId: u.companyId ?? NO_MATCH }),
    // A source has no project workflow of its own; it used to fall through and
    // read every project, private ones included. Limited to the public
    // showcase, same as a mentee.
    SOURCE: async () => ({ isPublic: true }),
  },
};

/**
 * The `where` fragment this user may read for `resource`, or `null` when the
 * role has no defined scope — which the caller must turn into a 403.
 */
export async function scopeForRole<K extends ScopedResource>(
  user: ScopeUser,
  resource: K
): Promise<ScopeMap[K] | null> {
  const build = BUILDERS[resource][user.role];
  if (!build) return null;
  return (await build(user)) as ScopeMap[K];
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
