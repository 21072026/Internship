// The one way an SSO sign-in becomes a session (#545, #1929): a VERIFIED
// identity from either protocol — a SAML assertion (ACS route) or an OIDC ID
// token (callback route) — is mapped to a role, JIT-provisioned and handed to
// the `sso` NextAuth provider through a 2-minute single-use SsoLoginGrant on
// /auth/sso/complete. There is deliberately no second session-minting path:
// every rule provisionSsoUser and the `sso` provider enforce applies to both.

import { NextResponse, after } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { provisionSsoUser } from '@/lib/ssoProvisioning';
import { syncSsoPhoto, syncSsoProfile } from '@/lib/ssoDirectorySync';
import { isEligible } from '@/lib/eligibility';
import { logActivity } from '@/lib/activity';
import { mappableRolesFor, resolveRole, type SsoClaims } from '@/lib/ssoRoleMapping';
import { verticalCapabilities } from '@/lib/verticals';
import { worldOfOrg } from '@/lib/userWorld';
import { originForWorld, worldForHostHeader } from '@/lib/hostWorld';
import { servedOrigin } from '@/lib/servedHosts';
import { verifiedTenantHosts } from '@/lib/hostOrg';

export const ssoBase = () => (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');

// Where the browser goes after the IdP sent it back. The IdP always returns to
// the URL it has registered (NEXTAUTH_URL's host), but the SESSION has to be
// minted on the host of the product the organization lives in (#2590): the
// `sso` provider refuses an account whose world is not the host's, and it
// burns the single-use grant BEFORE refusing — so handing a marketing
// organization's grant to the internship host would waste it and sign nobody
// in. An internship organization keeps `ssoBase()` exactly as before; only a
// marketing organization is sent to the marketing host.
//
// Within that world, the host the sign-in STARTED on wins (#2494): the login
// route carries that origin (SAML RelayState; the OIDC request row), so a
// sign-in begun on another host of the same product finishes there. RelayState
// is unsigned and chosen by whoever makes the browser POST to the ACS, so it is
// honoured only through servedOrigin() (a bare origin of a host this deployment
// serves, exact match — no open redirect) AND only when that host belongs to
// the organization's own world; anything else falls back to the world's origin.
// With no organization at all (an unknown slug) there is only a refusal to show
// and no grant to strand, so any served origin will do.
function startedHost(started: string | null): string | null {
  try {
    return started ? new URL(started).hostname : null;
  } catch {
    return null;
  }
}

export async function landingOrigin(orgId: string | null | undefined, started: string | null): Promise<string> {
  const world = await worldOfOrg(orgId);
  const origin = servedOrigin(started, await verifiedTenantHosts(startedHost(started)));
  if (origin && (!orgId || worldForHostHeader(new URL(origin).host) === world)) return origin;
  if (world === 'MARKETING') return originForWorld('MARKETING');
  return ssoBase();
}

export const ssoFail = (reason: string, origin: string = ssoBase()) =>
  NextResponse.redirect(`${origin}/auth/signin?error=${reason}`, 303);

/**
 * Map the claims to a role, provision the account and mint the grant. The
 * caller has already verified `email`/`claims` (signature, audience, expiry…).
 * Returns the redirect to /auth/sso/complete, or `sso_conflict` when the
 * address cannot be provisioned into this tenant.
 */
export async function completeSsoSignIn(
  org: { id: string; vertical: string; ssoSyncRole: boolean; ssoAuthoritative: boolean },
  identity: { email: string; fullName: string | null; claims: SsoClaims },
  origin: string,
): Promise<{ response: NextResponse; userId: string | null }> {
  try {
    // The tenant's IdP role mapping (#1940). Explicitly this org's rows — the
    // SSO routes are sessionless, so no tenant scope is bound to do it for us.
    // No match is null, and provisioning falls back to MENTEE. Only the roles
    // the org's vertical has (#2839): a row holding one it lacks grants nothing.
    const mappings = await prisma.ssoClaimMapping.findMany({
      where: { orgId: org.id },
      select: { claim: true, matchValue: true, role: true, priority: true },
    });
    const role = resolveRole(mappings, identity.claims, mappableRolesFor(verticalCapabilities(org.vertical)));
    const { user, created } = await provisionSsoUser({ orgId: org.id, email: identity.email, fullName: identity.fullName, role, syncRole: org.ssoSyncRole });
    await refreshFromDirectory(user.id, org, identity.claims);
    // Programme eligibility (#1945): judged AFTER the directory sync, on the
    // profile the IdP just wrote. Never a failed login: an account nobody's
    // rule admits waits in the admin's approval queue instead.
    if (await heldForApproval(user, created, org.id)) {
      return { response: ssoFail('sso_pending_approval', origin), userId: null };
    }
    // A short-lived single-use grant the `sso` provider will consume.
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.ssoLoginGrant.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + 2 * 60 * 1000) },
    });
    return { response: NextResponse.redirect(`${origin}/auth/sso/complete?token=${token}`, 303), userId: user.id };
  } catch (e) {
    // e.g. the email already belongs to a different tenant.
    console.error('SSO provisioning failed:', e);
    return { response: ssoFail('sso_conflict', origin), userId: null };
  }
}

// The directory sync (#1943): the profile fields now, so the first page after
// sign-in already shows them; the photo after the response, because a slow
// photo host must not hold up a sign-in. Neither may fail the sign-in — a
// refusal is recorded on the user (ssoSyncError) and in the activity log.
async function refreshFromDirectory(userId: string, org: { id: string; ssoAuthoritative: boolean }, claims: SsoClaims) {
  try {
    const synced = await syncSsoProfile(userId, org, claims);
    const photo = synced?.photo;
    if (photo) {
      after(() => syncSsoPhoto(userId, org, photo).catch((e) => console.error('SSO photo sync failed:', e)));
    }
  } catch (e) {
    console.error('SSO directory sync failed:', e);
  }
}

// A NEW participant (MENTEE) of an org in RULES mode whom no ALLOW rule admits
// is provisioned inactive + pendingApproval — an exception is then one admin
// click, not a mystery error. Only on creation: a returning user was admitted
// once and is not deactivated by a later rule change on their next sign-in.
// A user still waiting is answered the same way rather than with a grant the
// `sso` provider would refuse as "deactivated".
async function heldForApproval(user: { id: string; role: string }, created: boolean, orgId: string): Promise<boolean> {
  if (!created) {
    const row = await prisma.user.findUnique({ where: { id: user.id }, select: { isActive: true, pendingApproval: true } });
    return !!row && !row.isActive && row.pendingApproval;
  }
  if (user.role !== 'MENTEE') return false;
  const decision = await isEligible({ id: user.id, orgId });
  if (decision.ok) return false;
  await prisma.user.update({ where: { id: user.id }, data: { isActive: false, pendingApproval: true } });
  await logActivity({
    action: 'eligibility.denied',
    level: 'warning',
    actorId: null,
    targetType: 'user',
    targetId: user.id,
    detail: `SSO JIT held for approval: ${decision.reason}${decision.ruleId ? ` (rule ${decision.ruleId})` : ''}`,
  });
  return true;
}
