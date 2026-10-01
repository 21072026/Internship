// Just-in-time (JIT) user provisioning for Enterprise SSO (#545).
//
// When a tenant's IdP vouches for a user on first login, we create (or adopt) a
// matching `User` in that tenant's org — so admins don't have to pre-create every
// account. This is the piece behind #545's "JIT-provisioned user lands in the
// correct tenant + role" acceptance criterion.
//
// SECURITY: this must be called ONLY after a signed SAML assertion has been
// verified by the SSO callback — it trusts its inputs. It is never a public
// entry point. The live callback is `POST /api/auth/sso/[slug]/acs`, which
// verifies the assertion via `src/lib/ssoSaml.ts` before calling in (see
// docs/sso-saml.md). This helper is the tenant-mapping half, isolated so it is
// unit-testable without a real IdP. (OIDC is a roadmap item — it is refused at
// the SSO config write boundary, so no OIDC token reaches here.)
//
// Server-only (imports prisma). No client concerns.

import { prisma } from './prisma';
import { findUsersInWorld, worldOfOrg } from './userWorld';
import { logActivity } from './activity';
import type { SsoRole } from './ssoRoleMapping';

// Roles an IdP attribute mapping may grant — the type and the rule that picks
// one live in src/lib/ssoRoleMapping.ts (#1940). Defaults to the
// least-privilege MENTEE when no mapping matches — an admin can elevate later.
export type { SsoRole };

export interface SsoIdentity {
  orgId: string; // the tenant the IdP config belongs to (resolved by the caller)
  email: string; // the IdP-verified email (subject / email claim)
  fullName?: string | null;
  // From the tenant's IdP role mapping (resolveRole); absent → MENTEE on create.
  role?: SsoRole | null;
  // Organization.ssoSyncRole (#1940): re-apply `role` to a RETURNING user. Off
  // by default — see syncReturningRole below.
  syncRole?: boolean;
}

export interface ProvisionResult {
  user: { id: string; email: string; role: string; orgId: string | null };
  created: boolean;
}

// Map a verified IdP identity to a User in the tenant org, creating one on first
// login. Idempotent per (email, org). Throws when the email already belongs to a
// DIFFERENT org of the same product (a misconfiguration we must not paper over
// by silently moving a user across tenants).
//
// ONE PERSON, TWO WORLDS (#2590). The address can also be an account in the
// OTHER product — an internship user and a marketing user with the same mailbox
// are two rows in two tenants, and the IdP config tells us exactly which org
// (hence which product) this login is for. So the match is by (email, THIS org),
// and a row in the other world is simply not a candidate: the person gets a
// fresh account here, and their other-world account is left exactly as it was.
// It is never adopted, and its `orgId` is never moved to the SSO org — moving it
// would rip the person out of the product they already use.
export async function provisionSsoUser(identity: SsoIdentity): Promise<ProvisionResult> {
  const email = identity.email.trim().toLowerCase();
  if (!email) throw new Error('SSO identity has no email');
  if (!identity.orgId) throw new Error('SSO provisioning requires a resolved orgId');

  const select = { id: true, email: true, role: true, orgId: true } as const;

  // 1. This org's own account for the address: the ordinary returning login.
  const own = await prisma.user.findFirst({ where: { email, orgId: identity.orgId }, select });
  if (own) return { user: await syncReturningRole(own, identity), created: false };

  // 2. Accounts for the address in this org's WORLD but not in this org. (The
  //    other world's rows are deliberately not looked at.)
  const inWorld = await findUsersInWorld(email, await worldOfOrg(identity.orgId), select);
  // Never silently relocate a user to another tenant.
  if (inWorld.some((u) => u.orgId && u.orgId !== identity.orgId)) {
    throw new Error('SSO identity email already belongs to a different organization');
  }
  // Adopt a not-yet-tenanted user (e.g. from the single-tenant default org)
  // into this org on first SSO login. An org-less row IS the default org, i.e.
  // the internship world, so it can only appear in `inWorld` when this org is
  // an internship-world org too — a marketing SSO org never claims it. This is
  // the ONLY case where a row's orgId is moved.
  const orgless = inWorld.find((u) => !u.orgId);
  if (orgless) {
    const user = await prisma.user.update({
      where: { id: orgless.id },
      data: { orgId: identity.orgId },
      select,
    });
    return { user, created: false };
  }

  const user = await prisma.user.create({
    data: {
      email,
      // SSO users authenticate via the IdP — no local password login.
      password: '!sso-no-login',
      role: identity.role ?? 'MENTEE',
      fullName: identity.fullName?.trim() || email,
      orgId: identity.orgId,
      emailVerified: true, // the IdP vouched for this address
      skills: [],
    },
    select,
  });
  return { user, created: true };
}

// Re-evaluation of a returning user's role (#1940), opt-in per tenant. Three
// guards, each on purpose:
//   - off unless the tenant switched `ssoSyncRole` on: with it off, a user
//     elevated locally is never touched by a login;
//   - a login whose claims match NO mapping changes nothing (`role` absent):
//     a missing claim is not evidence of a demotion;
//   - an ADMIN row is never re-evaluated. ADMIN is not mappable yet (#1575),
//     so every ADMIN is a locally granted one, and turning sync on must not
//     lock a tenant's own administrators out.
// Every change is written to the activity log at warning level, old -> new.
async function syncReturningRole<U extends { id: string; email: string; role: string; orgId: string | null }>(
  user: U,
  identity: SsoIdentity,
): Promise<U> {
  const next = identity.role;
  if (!identity.syncRole || !next || next === user.role || user.role === 'ADMIN') return user;
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { role: next },
    select: { id: true, email: true, role: true, orgId: true },
  });
  await logActivity({
    action: 'sso.role_synced',
    level: 'warning',
    actorId: null,
    targetType: 'user',
    targetId: user.id,
    detail: `${user.role} -> ${next} (IdP role mapping, org ${identity.orgId})`,
  });
  return { ...user, ...updated };
}
