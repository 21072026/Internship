// Enforced SSO — the ONE rule every password-derived door checks (#1950).
//
// "Force login via SSO" is a single line in a security questionnaire, and the
// honest answer is a hard no while any other path can still mint a session. A
// password form is not the only such path in this app; there are five, and an
// enforcement that closes one of them is a *claim* with a back door, which is
// worse than no claim at all. So the rule lives here, once, and every door
// calls it:
//
//   1. credentials sign-in            src/lib/auth.ts
//   2. "remember me" silent re-auth   src/lib/auth.ts ('remember') and
//                                     src/app/api/auth/remember/refresh/route.ts
//   3. password reset completion      src/app/api/auth/reset/route.ts
//      (RESET and SET_INITIAL both land there)
//   4. invitation / self registration src/app/api/register/route.ts
//   5. self-service password change   src/app/api/account/route.ts
//
// Deliberately NOT enforced: the `impersonate` provider and the `sso` provider.
// The reasoning for impersonation is written down in docs/sso-saml.md — in
// short, it mints no session from a password, it is admin-guarded, audited and
// time-capped, and refusing it would remove support access from exactly the
// tenants most likely to need it during an IdP incident.
//
// Two things this module is careful about:
//
//   * The org is resolved from `user.orgId` DIRECTLY. The ambient tenant
//     context (src/lib/orgContext.ts) is not populated on the pre-auth path,
//     and MT_ENFORCE_ISOLATION is off in production anyway (#1549). Every read
//     here runs inside `runWithOrg(null, …)` so an ambient scope bound by a
//     caller can never narrow it either.
//   * Enforcement only APPLIES while SSO is genuinely active for the tenant
//     (`isSsoActive`). `ssoEnforced` can only be switched on while it is (see
//     `ssoEnforcementBlockers`), but a later plan downgrade or a config the
//     admin broke would otherwise leave a tenant with no working door at all.
//     Falling back to password login there is the deliberate choice: the flag
//     stays set and re-engages the moment SSO works again.

import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { runWithOrg } from '@/lib/orgContext';
import { revokeTrustedDevicesForUsers } from '@/lib/trustedDevice';
import { logActivity } from '@/lib/activity';

/**
 * The message the API doors return. Deliberately identical everywhere, and
 * deliberately explicit: a user told "invalid password" by an organization that
 * has switched their password off will keep trying, then call support.
 */
export const SSO_REQUIRED_MESSAGE =
  'Your organization requires single sign-on. Sign in through your identity provider.';

/** Machine-readable twin of the message, for clients that branch on it. */
export const SSO_REQUIRED_CODE = 'sso_required';

/** The shape every door already has in hand after loading its user row. */
export interface SsoEnforcementSubject {
  orgId: string | null;
  ssoExempt: boolean;
}

/** Exactly the org columns the rule reads. */
const ORG_ENFORCEMENT_SELECT = {
  id: true,
  plan: true,
  ssoEnabled: true,
  ssoEnforced: true,
  ssoProvider: true,
  ssoIssuer: true,
  ssoEntryPoint: true,
  ssoCertificate: true,
} as const;

/**
 * THE rule. True when this user may not use any password-derived door.
 *
 * A user with no org, an org that is not enforcing, or a break-glass exemption
 * is unaffected — as is every user of a tenant whose SSO has stopped being
 * active (see the module header).
 */
export async function isPasswordLoginBlocked(user: SsoEnforcementSubject): Promise<boolean> {
  if (user.ssoExempt) return false;
  if (!user.orgId) return false;
  return isOrgEnforcingSso(user.orgId);
}

/**
 * Same rule for a door that has an org but no user yet — registration, where
 * the account being created cannot possibly hold an exemption.
 */
export async function isOrgEnforcingSso(orgId: string | null): Promise<boolean> {
  if (!orgId) return false;
  const org = await runWithOrg(null, () =>
    prisma.organization.findUnique({ where: { id: orgId }, select: ORG_ENFORCEMENT_SELECT })
  );
  if (!org?.ssoEnforced) return false;
  return isSsoActive(org);
}

/**
 * Same rule for a door that only holds a user id — the password-reset token
 * carries one, not a row.
 */
export async function isPasswordLoginBlockedForUserId(userId: string): Promise<boolean> {
  const user = await runWithOrg(null, () =>
    prisma.user.findUnique({ where: { id: userId }, select: { orgId: true, ssoExempt: true } })
  );
  if (!user) return false;
  return isPasswordLoginBlocked(user);
}

// ── Anti-lockout guard ───────────────────────────────────────────────────────

export type SsoEnforcementBlocker = 'SSO_NOT_ACTIVE' | 'NO_EXEMPT_ADMIN';

/**
 * Why this org may NOT switch enforcement on, or an empty list when it may.
 *
 * Both interlocks are mandatory, and the second one is the whole reason this is
 * not a one-line boolean: a tenant that enables enforcement with a
 * misconfigured IdP and no exempt admin has no way back into its own account
 * except our database console. `isSsoActive` is evaluated against the config
 * this request LEAVES the org on, not the stored one, so enabling SSO and
 * enforcing it in a single PATCH is judged on the result.
 */
export async function ssoEnforcementBlockers(
  orgId: string,
  effectiveConfig: Parameters<typeof isSsoActive>[0]
): Promise<SsoEnforcementBlocker[]> {
  const blockers: SsoEnforcementBlocker[] = [];
  if (!isSsoActive(effectiveConfig)) blockers.push('SSO_NOT_ACTIVE');
  if ((await countExemptAdmins(orgId)) === 0) blockers.push('NO_EXEMPT_ADMIN');
  return blockers;
}

/** Active ADMINs of the org holding a break-glass exemption. */
export function countExemptAdmins(orgId: string): Promise<number> {
  return runWithOrg(null, () =>
    prisma.user.count({ where: { orgId, role: 'ADMIN', isActive: true, ssoExempt: true } })
  );
}

/** How many of the org's users a sweep would sign out (everyone non-exempt). */
export function countSweepableUsers(orgId: string): Promise<number> {
  return runWithOrg(null, () => prisma.user.count({ where: { orgId, ssoExempt: false } }));
}

// ── The sweep on flip ────────────────────────────────────────────────────────

/**
 * How many users one pass of the sweep touches. An org can hold thousands, and
 * a single unbounded `updateMany` over all of them is a lock we do not want to
 * take inside an admin request.
 */
const SWEEP_BATCH = 500;

/**
 * End every password-derived session in the org, in bounded batches.
 *
 * HARD RULE (CLAUDE.md, docs/remember-me.md): stamping `sessionsValidFrom`
 * without also revoking the trusted devices does nothing — the browser trades
 * its remember-me cookie for a fresh session on the very next visit and the
 * user never notices they were signed out. The two always go together, which is
 * why this function does both and no caller is offered half of it.
 *
 * Idempotent: a second run stamps a later cutoff and revokes nothing new.
 * Exempt users are skipped — an exemption signed out by the very flip it exists
 * to survive would be no exemption at all.
 *
 * Returns the number of users swept.
 */
export async function sweepSessionsForSsoEnforcement(orgId: string): Promise<number> {
  const now = new Date();
  let swept = 0;
  let cursor: string | undefined;

  for (;;) {
    const batch: { id: string }[] = await runWithOrg(null, () =>
      prisma.user.findMany({
        where: { orgId, ssoExempt: false },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: SWEEP_BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      })
    );
    if (batch.length === 0) break;

    const ids = batch.map((u) => u.id);
    await runWithOrg(null, () =>
      prisma.user.updateMany({ where: { id: { in: ids } }, data: { sessionsValidFrom: now } })
    );
    // The other half of the hard rule. Never separate these two statements.
    await revokeTrustedDevicesForUsers(ids);

    swept += ids.length;
    cursor = ids[ids.length - 1];
    if (batch.length < SWEEP_BATCH) break;
  }

  return swept;
}

/**
 * The audited flip: sweep, then write ONE `sso.enforced` row carrying the count.
 * Kept beside the sweep so a future write path cannot acquire the flag without
 * ending the sessions it is supposed to end.
 */
export async function applySsoEnforcement(
  orgId: string,
  actor: { id?: string | null; email?: string | null },
  request?: Request
): Promise<number> {
  const swept = await sweepSessionsForSsoEnforcement(orgId);
  await logActivity({
    action: 'sso.enforced',
    level: 'warning',
    actorId: actor.id ?? null,
    actorEmail: actor.email ?? null,
    targetType: 'organization',
    targetId: orgId,
    detail: `SSO enforcement enabled; ${swept} user${swept === 1 ? '' : 's'} signed out and their trusted devices revoked`,
    request,
  });
  return swept;
}
