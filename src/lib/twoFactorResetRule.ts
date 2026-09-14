// Who may clear somebody else's second factor, and who may not (#1543).
//
// WHY THIS IS ITS OWN FILE
//   Wiping a user's TOTP secret is an account-takeover primitive: whoever can
//   do it can turn any protected account into a password-only account and then
//   walk in through the front door with a reset link. So the decision is not a
//   handful of `if`s scattered through a route handler where the next edit can
//   drop one — it is a pure function with no imports, unit tested
//   (scripts/test/two-factor-reset-rule.test.mjs) against every refusal it is
//   supposed to make. `lastContactRule.ts` is the same pattern for the same
//   reason: the rule is the product, the route is plumbing.
//
// THE FOUR REFUSALS, and why each one exists
//   1. NOT AN ADMIN — the session role check every admin route starts with.
//   2. CAPABILITY REVOKED — the role is read LIVE from the database, not from
//      the JWT. A session token lives 12h, so an admin demoted or deactivated
//      at 09:00 would otherwise keep this power until their token refreshes.
//      Same reasoning, and the same one indexed point lookup, as
//      `isSuperAdmin()` in src/lib/superAdmin.ts. This is what makes the gate a
//      capability check rather than "the token says ADMIN".
//   3. IMPERSONATING — matching /api/account/2fa and the other admin user
//      actions: an admin wearing someone else's identity must not reach a
//      security control that is logged as a deliberate administrative act.
//   4. AN ADMIN TARGET — the peer-admin rule from reset-password/sign-out-all,
//      widened to include the caller themselves. Self is refused on purpose:
//      the account-owned route (/api/account/2fa, action `disable`) demands a
//      valid authenticator code before it will switch the factor off, and this
//      route demands none. Letting an admin point it at their own id would turn
//      a stolen admin session into a code-free way to strip that session's own
//      second factor. An admin who has genuinely lost their authenticator asks
//      another admin — or, when they are the only one, the same escape hatch
//      every other locked-out person has.
//
// NOT A SUBSTITUTE FOR TENANT SCOPING. Which users the caller can even see is
// decided by `withTenantScope` around the lookup, one layer out; this function
// is only asked about two rows that are already in scope.

/** The acting admin, with `role`/`isActive` read from the database, not the JWT. */
export interface TwoFactorResetActor {
  id: string;
  role: string;
  isActive: boolean;
  /** True when the session carries an `impersonatorId`. */
  isImpersonating: boolean;
}

/** The account whose factor would be cleared. */
export interface TwoFactorResetTarget {
  id: string;
  role: string;
}

export type TwoFactorResetDenialCode =
  | 'not_admin'
  | 'admin_capability_revoked'
  | 'impersonating'
  | 'self_target'
  | 'peer_admin';

export type TwoFactorResetDecision =
  | { ok: true }
  | { ok: false; code: TwoFactorResetDenialCode; status: number; error: string };

const deny = (
  code: TwoFactorResetDenialCode,
  status: number,
  error: string,
): TwoFactorResetDecision => ({ ok: false, code, status, error });

/**
 * May `actor` clear `target`'s two-factor authentication?
 *
 * The refusals are ordered from "you are not who you claim" outwards to "not
 * this target", so the message a caller gets names the first thing that is
 * actually wrong with the request.
 */
export function evaluateTwoFactorReset(
  actor: TwoFactorResetActor | null | undefined,
  target: TwoFactorResetTarget,
): TwoFactorResetDecision {
  if (!actor || actor.role !== 'ADMIN') {
    return deny('not_admin', 401, 'Unauthorized');
  }
  if (!actor.isActive) {
    return deny(
      'admin_capability_revoked',
      403,
      'Your administrator access is no longer active.',
    );
  }
  if (actor.isImpersonating) {
    return deny(
      'impersonating',
      400,
      'Cannot reset two-factor authentication while impersonating',
    );
  }
  if (target.role === 'ADMIN') {
    return target.id === actor.id
      ? deny(
          'self_target',
          400,
          'Use your own security settings to change your two-factor authentication',
        )
      : deny(
          'peer_admin',
          400,
          "Cannot reset another admin's two-factor authentication",
        );
  }
  return { ok: true };
}
