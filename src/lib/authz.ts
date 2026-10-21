// The permission layer's server half (#1569, story #1565). The rule — the
// catalogue, the tier table and every allow/deny — is pure in
// src/lib/authzRule.ts; this file only gathers the facts it needs: who is
// signed in (read LIVE, see below), whether they are a super admin of the
// subject's world, and a PROGRAM_ADMIN's scope grants.
//
// `requirePermission()` is the route guard. It is deliberately NOT named
// `requireCapability()`: that name belongs to the per-vertical product gate in
// src/lib/capabilityGate.ts ("is this module part of the tenant's product?"),
// which keeps working unchanged. A handler may need both — they answer
// different questions.
//
// LIVE, not from the JWT. The session token carries `adminLevel` for the UI,
// but a token lives 12h, and narrowing an admin to OBSERVER at 09:00 must
// bite on the next request — the same reasoning, and the same one indexed
// point lookup, as `isSuperAdmin` (src/lib/superAdmin.ts) and the
// `sessionsValidFrom` check in src/lib/auth.ts.
//
// SERVER-ONLY: it reads the session and Prisma. The UI learns what it may do
// from an API response, never by importing this.

import 'server-only';
import { NextResponse } from 'next/server';
import { getServerSession, type Session } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { superAdminWorld } from '@/lib/superAdmin';
import { superAdminReaches } from '@/lib/superAdminWorld';
import { worldOfOrg } from '@/lib/userWorld';
import {
  adminTierFor,
  decide,
  isPermission,
  isPlatformPermission,
  type Actor,
  type Decision,
  type DenialReason,
  type Permission,
  type ScopeGrant,
  type Subject,
} from '@/lib/authzRule';

export type { Actor, Permission, ScopeGrant, Subject } from '@/lib/authzRule';
export { PERMISSIONS, TIER_PERMISSIONS, ADMIN_TIERS } from '@/lib/authzRule';

/** The actor's AdminScopeGrant rows in its own org. Only a PROGRAM_ADMIN reads them. */
export async function scopeGrantsFor(actor: Pick<Actor, 'id' | 'orgId'>): Promise<ScopeGrant[]> {
  if (!actor.orgId) return [];
  return prisma.adminScopeGrant.findMany({
    where: { userId: actor.id, orgId: actor.orgId },
    select: { orgId: true, cohortId: true, companyId: true },
  });
}

/**
 * The actor behind a session, from the live user row: role, tier, org and
 * company as they are NOW. Null for no session, a deleted account or an
 * inactive one. Under impersonation the session IS the impersonated user, so
 * the actor is too — it can never hold more than that person does.
 */
export async function actorFromSession(session: Session | null | undefined): Promise<Actor | null> {
  const id = session?.user?.id;
  if (!id) return null;
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, adminLevel: true, orgId: true, companyId: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return {
    id: user.id,
    role: user.role,
    adminLevel: adminTierFor(user.role, user.adminLevel),
    orgId: user.orgId,
    companyId: user.companyId,
    impersonatorId: session?.user?.impersonatorId ?? null,
  };
}

async function decideFor(
  actor: Actor,
  permission: Permission,
  subject: Subject | undefined,
  session: Session | null | undefined,
  listing = false,
): Promise<{ decision: Decision; grants?: ScopeGrant[] }> {
  let platformReach = false;
  if (isPlatformPermission(permission) && session) {
    const world = await superAdminWorld(session);
    platformReach =
      world !== null &&
      (subject?.orgId == null ? true : superAdminReaches(world, await worldOfOrg(subject.orgId)));
  }
  const grants = actor.adminLevel === 'PROGRAM_ADMIN' ? await scopeGrantsFor(actor) : undefined;
  return { decision: decide({ actor, permission, subject, platformReach, grants, listing }), grants };
}

/**
 * May this actor do this to this subject? `session` is needed only to answer
 * a `platform.*` question (the super admin check reads the request host); a
 * call without it is refused every platform permission.
 */
export async function can(
  actor: Actor,
  action: Permission,
  subject?: Subject,
  session?: Session | null,
): Promise<boolean> {
  return (await decideFor(actor, action, subject, session)).decision.allow;
}

/** One warning-level `authz.capability_denied` row per refusal. Never throws (logActivity). */
export async function logPermissionDenial(
  actor: Pick<Actor, 'id' | 'role' | 'adminLevel' | 'orgId'> & { email?: string | null },
  permission: string,
  route: string,
  reason: DenialReason,
): Promise<void> {
  await logActivity({
    action: 'authz.capability_denied',
    level: 'warning',
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    targetType: 'route',
    targetId: route,
    detail: `${permission} denied (${reason}) for ${actor.role}/${actor.adminLevel ?? 'no tier'}`,
    orgId: actor.orgId,
  });
}

function routeOf(request?: Request | null): string {
  if (!request) return 'unknown';
  try {
    return new URL(request.url).pathname;
  } catch {
    return 'unknown';
  }
}

/**
 * The route guard. 401 without a session (or for a deleted/inactive account),
 * 403 `permission_denied` on a refusal — after writing the denial row — and the
 * resolved actor otherwise. Pass the request so the denial names its route.
 *
 * `listing: true` is for a list endpoint with no single subject: a
 * PROGRAM_ADMIN with grants passes and gets `grants` back — the handler must
 * narrow its rows to them (every other tier gets `grants` undefined and reads
 * its whole org).
 *
 *     const gate = await requirePermission('audit.read', { request });
 *     if ('error' in gate) return gate.error;
 *     const { actor } = gate;
 */
export async function requirePermission(
  action: Permission,
  opts: { subject?: Subject; request?: Request | null; listing?: boolean } = {},
): Promise<{ actor: Actor; session: Session; grants?: ScopeGrant[] } | { error: NextResponse }> {
  const session = await getServerSession(authOptions);
  const actor = await actorFromSession(session);
  if (!session || !actor) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  // A misspelt name in a caller is a deny, not a crash — and the row says so.
  const { decision, grants } = isPermission(action)
    ? await decideFor(actor, action, opts.subject, session, opts.listing === true)
    : { decision: { allow: false, reason: 'unknown_permission' } as Decision, grants: undefined };
  if (!decision.allow) {
    await logPermissionDenial(
      { ...actor, email: session.user?.email ?? null },
      String(action),
      routeOf(opts.request),
      decision.reason,
    );
    return {
      error: NextResponse.json(
        { code: 'permission_denied' as const, permission: action, error: 'Forbidden' },
        { status: 403 },
      ),
    };
  }
  return { actor, session, grants };
}
