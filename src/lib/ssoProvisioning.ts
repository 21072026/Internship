// Just-in-time (JIT) user provisioning for Enterprise SSO (#545).
//
// When a tenant's IdP vouches for a user on first login, we create (or adopt) a
// matching `User` in that tenant's org — so admins don't have to pre-create every
// account. This is the piece behind #545's "JIT-provisioned user lands in the
// correct tenant + role" acceptance criterion.
//
// SECURITY: this must be called ONLY after a signed SAML assertion / OIDC token
// has been verified by the (future, gated) SSO callback — it trusts its inputs.
// It is never a public entry point. The live callback that verifies the IdP
// round-trip is still deferred (see docs/sso-saml.md); this helper is the
// tenant-mapping half, isolated so it is unit-testable without a real IdP.
//
// Server-only (imports prisma). No client concerns.

import { prisma } from './prisma';

// Roles an IdP attribute mapping may grant. Defaults to the least-privilege
// MENTEE when the assertion carries no role — an admin can elevate later.
export type SsoRole = 'MENTEE' | 'MENTOR' | 'ADMIN' | 'COMPANY' | 'SOURCE';

export interface SsoIdentity {
  orgId: string; // the tenant the IdP config belongs to (resolved by the caller)
  email: string; // the IdP-verified email (subject / email claim)
  fullName?: string | null;
  role?: SsoRole; // from IdP attribute mapping; default MENTEE
}

export interface ProvisionResult {
  user: { id: string; email: string; role: string; orgId: string | null };
  created: boolean;
}

// Map a verified IdP identity to a User in the tenant org, creating one on first
// login. Idempotent per email. Throws when the email already belongs to a
// DIFFERENT org (a misconfiguration we must not paper over by silently moving a
// user across tenants).
export async function provisionSsoUser(identity: SsoIdentity): Promise<ProvisionResult> {
  const email = identity.email.trim().toLowerCase();
  if (!email) throw new Error('SSO identity has no email');
  if (!identity.orgId) throw new Error('SSO provisioning requires a resolved orgId');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Never silently relocate a user to another tenant.
    if (existing.orgId && existing.orgId !== identity.orgId) {
      throw new Error('SSO identity email already belongs to a different organization');
    }
    // Adopt a not-yet-tenanted user (e.g. from the single-tenant default org)
    // into this org on first SSO login; otherwise return as-is.
    if (!existing.orgId) {
      const user = await prisma.user.update({
        where: { id: existing.id },
        data: { orgId: identity.orgId },
        select: { id: true, email: true, role: true, orgId: true },
      });
      return { user, created: false };
    }
    return {
      user: { id: existing.id, email: existing.email, role: existing.role, orgId: existing.orgId },
      created: false,
    };
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
    select: { id: true, email: true, role: true, orgId: true },
  });
  return { user, created: true };
}
