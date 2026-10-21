import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import type { Profile } from '@node-saml/node-saml';
import { samlLogoutForOrg, spEntityId } from '@/lib/ssoSaml';
import { ensureSpSigningKey } from '@/lib/ssoSpKey';
import { endAllSessionsForSlo, spInitiatedSloApplies } from '@/lib/ssoLogout';

// POST /api/auth/sso/logout — the SP-initiated half of SAML Single Logout
// (#1952). `signOutEverywhere()` (src/lib/signOutClient.ts) calls it on every
// sign-out, before NextAuth's own signOut; it answers `{ redirect: null }`
// unless the caller's org has SSO live with an IdP SLO endpoint.
//
// LOCAL FIRST. When SLO applies, this account's sessions and remembered
// devices are ended HERE, before any URL is handed back — so if the IdP is
// down, slow or never visited, the person is still signed out of us. Only then
// is the signed LogoutRequest built; a failure building it still answers 200
// with no redirect, because the local half already happened.
//
// No session → 401: there is nobody to sign out, and the route must not be a
// way to make the server sign LogoutRequests for arbitrary subjects.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // An admin inside an impersonation session signs out of the impersonation,
  // not the impersonated person's IdP.
  if (session.user.impersonatorId) return NextResponse.json({ redirect: null });

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, ssoExempt: true, orgId: true },
  });
  if (!user?.orgId) return NextResponse.json({ redirect: null });
  const org = await prisma.organization.findUnique({
    where: { id: user.orgId },
    select: {
      id: true,
      slug: true,
      plan: true,
      ssoEnabled: true,
      ssoProvider: true,
      ssoIssuer: true,
      ssoEntryPoint: true,
      ssoCertificate: true,
      ssoLogoutUrl: true,
      ssoSpKey: true,
      ssoSpCert: true,
    },
  });
  if (!org || !spInitiatedSloApplies(org, user)) return NextResponse.json({ redirect: null });

  await endAllSessionsForSlo(user.id);
  await logActivity({
    action: 'auth.slo',
    actorId: user.id,
    actorEmail: user.email,
    targetType: 'User',
    targetId: user.id,
    orgId: org.id,
    detail: 'SP-initiated: sessions and remembered devices ended, sent to the IdP',
  });

  try {
    const { privateKeyPem } = await ensureSpSigningKey(org);
    const redirect = await samlLogoutForOrg(org.slug, org, privateKeyPem).getLogoutUrlAsync(
      // No SessionIndex: we never stored one, and the logout is for every
      // session of this person anyway (src/lib/ssoLogout.ts).
      {
        issuer: spEntityId(org.slug),
        nameID: user.email,
        nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      } satisfies Profile,
      '',
      {},
    );
    return NextResponse.json({ redirect });
  } catch (e) {
    console.error('SSO LogoutRequest could not be built:', e);
    return NextResponse.json({ redirect: null });
  }
}
