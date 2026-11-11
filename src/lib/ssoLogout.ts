// SAML Single Logout (#1952) — the parts both directions share. The routes are
// POST /api/auth/sso/logout (SP-initiated, called by signOutEverywhere) and
// GET|POST /api/auth/sso/[slug]/slo (IdP-initiated, and the IdP's answer to
// ours). docs/sso-saml.md § Single Logout.
//
// ALL DEVICES, NOT ONE SESSION. Our sessions are stateless JWTs: there is no
// session row to end, so "log this session out" can only be said as "every
// token minted before now is void" — `sessionsValidFrom`. A SAML SessionIndex
// therefore has nothing to select, and an SLO for a person ends ALL of their
// sessions here, on every device. That is a deliberate deviation from the
// per-session model, like `validateInResponseTo: never`; it errs towards
// signed out, which is the side an SLO is for.
//
// ALWAYS BOTH HALVES (CLAUDE.md "Staying signed in"): stamping
// sessionsValidFrom without revoking the remembered devices lets the device
// cookie mint a fresh session on the next page load — the exact bug an SLO
// exists to prevent.

import { prisma } from '@/lib/prisma';
import { isSsoActive, type SsoActivation } from '@/lib/sso';
import { revokeAllTrustedDevices } from '@/lib/trustedDevice';

/** End every session and remembered device of one account. */
export async function endAllSessionsForSlo(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { sessionsValidFrom: new Date() }, select: { id: true } });
  await revokeAllTrustedDevices(userId);
}

/**
 * Does signing out in the app continue to the IdP's Single Logout? Only when
 * the org's SSO is live and the IdP advertised an SLO endpoint — and never for
 * a break-glass (`ssoExempt`) admin, who signs in with a password by design and
 * has no IdP session for us to end.
 */
export function spInitiatedSloApplies(
  org: (SsoActivation & { ssoLogoutUrl: string | null }) | null,
  user: { ssoExempt: boolean },
): boolean {
  // SAML only: an OIDC tenant (#1929) has no SAML SLO, and a logout URL left
  // over from an earlier SAML config must not send it one.
  return !!org && org.ssoProvider === 'saml' && isSsoActive(org) && !!org.ssoLogoutUrl?.trim() && !user.ssoExempt;
}
