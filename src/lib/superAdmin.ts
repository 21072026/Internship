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

import type { Session } from 'next-auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';

/**
 * Does this session belong to an active super admin? Reads the flag live, so a
 * revoked capability is gone on the very next request.
 */
export async function isSuperAdmin(session: Session | null | undefined): Promise<boolean> {
  const userId = session?.user?.id;
  // A super admin is still an ADMIN; the flag never grants a lesser role the
  // admin surface on its own.
  if (!userId || session?.user?.role !== 'ADMIN') return false;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isSuperAdmin: true, isActive: true },
  });
  return !!user?.isSuperAdmin && user.isActive;
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
    detail: `Not a super admin; own org ${session?.user?.orgId ?? 'none'}, target org ${targetOrgId ?? 'none'}`,
  });
}
