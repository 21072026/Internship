// Instance-level "super admin" capability (#1535).
//
// `role === 'ADMIN'` means *tenant* admin: the administrator of one customer's
// organisation. Managing the Organization rows themselves is a different power —
// it includes writing another tenant's SAML entry point and signing certificate,
// i.e. deciding who may mint a login for them. Only a super admin may do that.
//
// Two deliberate choices:
//
//  * It is a flag on User (`isSuperAdmin`), not a `SUPER_ADMIN` value on `Role`.
//    `role` is copied into the JWT and compared to 'ADMIN' in dozens of guards;
//    widening the enum would change all of them at once.
//  * The flag is read FROM THE DATABASE on every request, never from the JWT.
//    A session token lives for 12h, so a capability revoked at 09:00 would
//    otherwise keep working until the token refreshes. Same reasoning — and the
//    same one indexed point lookup — as the `sessionsValidFrom` check in
//    `src/lib/auth.ts`.
//
// SERVER-ONLY: it touches Prisma. Never import it from a client component; the
// UI learns about the capability from an API response instead.

// PER WORLD (docs/worlds.md § Super admin). The power is scoped to the world
// (product) of the super admin's OWN organization: an INTERNSHIP super admin
// sees and manages only INTERNSHIP organizations, a MARKETING one only
// MARKETING organizations, and on the other world's host the power is inert —
// the request host must be in the same world as the account. The session
// callback already refuses a session on the wrong world's host (#2590); the
// host check here is the second, independent lock, so a future change there
// cannot quietly turn one world's operator into both worlds'. The rule itself
// is pure and unit-tested in superAdminWorld.ts.

import type { Session } from 'next-auth';
import { headers } from 'next/headers';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { worldForHeaders } from '@/lib/hostWorld';
import { worldOfOrg } from '@/lib/userWorld';
import type { VerticalKey } from '@/lib/verticals';
import { superAdminReaches, superAdminWorldFrom } from '@/lib/superAdminWorld';

/** The world of the current request's host, or null outside a request (fail closed). */
async function requestWorld(): Promise<VerticalKey | null> {
  try {
    const h = await headers();
    return worldForHeaders((n) => h.get(n));
  } catch {
    return null;
  }
}

/**
 * The world this session is a super admin OF, on this request — or null. Reads
 * the flag, the active bit and the caller's organization live (never the JWT),
 * and returns null on the other world's host.
 */
export async function superAdminWorld(session: Session | null | undefined): Promise<VerticalKey | null> {
  const userId = session?.user?.id;
  // A super admin is still an ADMIN; the flag never grants a lesser role the
  // admin surface on its own.
  if (!userId || session?.user?.role !== 'ADMIN') return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isSuperAdmin: true, isActive: true, orgId: true },
  });
  if (!user?.isSuperAdmin || !user.isActive) return null;
  return superAdminWorldFrom({
    flag: user.isSuperAdmin,
    active: user.isActive,
    role: session.user.role,
    callerWorld: await worldOfOrg(user.orgId),
    requestWorld: await requestWorld(),
  });
}

/**
 * Is this session a super admin of its world, on this request? The world-less
 * question, for surfaces that are about the caller's own world as a whole (the
 * mail log, the organization list); anything that names a target organization
 * asks `isSuperAdminFor` instead.
 */
export async function isSuperAdmin(session: Session | null | undefined): Promise<boolean> {
  return (await superAdminWorld(session)) !== null;
}

/**
 * May this session act as a super admin ON this organization? True only when
 * it is a super admin here AND the target organization is in the same world.
 * A missing target organization is the default world's (worldOfOrg's rule),
 * so a caller must still 404 a non-existent id itself.
 */
export async function isSuperAdminFor(
  session: Session | null | undefined,
  targetOrgId: string | null | undefined,
): Promise<boolean> {
  const world = await superAdminWorld(session);
  if (!world) return false;
  return superAdminReaches(world, await worldOfOrg(targetOrgId));
}

/**
 * Audit a refused cross-tenant attempt at warning level — a denial is exactly
 * the row an auditor asks for. Mirrors `logScopeDenial` in `authzScope.ts`
 * (same `authz.scope_denied` action), but records which organisation was
 * targeted, which is the whole question here.
 */
export async function logCrossTenantDenial(
  session: Session | null | undefined,
  route: string,
  targetOrgId: string | null,
): Promise<void> {
  await logActivity({
    action: 'authz.scope_denied',
    level: 'warning',
    actorId: session?.user?.id ?? null,
    actorEmail: session?.user?.email ?? null,
    targetType: 'route',
    targetId: route,
    detail: `Not a super admin of the target's world; own org ${session?.user?.orgId ?? 'none'}, target org ${targetOrgId ?? 'none'}`,
  });
}
