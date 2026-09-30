import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { samlForOrg } from '@/lib/ssoSaml';
import { configuredOrigin, requestOrigin } from '@/lib/servedHosts';

// GET /api/auth/sso/[slug]/login — SP-initiated SSO. Resolve the tenant, and if
// SSO is active build a SAML AuthnRequest and redirect the browser to the IdP.
// Public (pre-auth) by nature. Falls back to the password page when SSO isn't
// active for the tenant, so a wrong/disabled slug never dead-ends.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // The failure redirects stay on the host the browser is on (#2488): a
  // marketing visitor typing an unknown org code used to be bounced to the
  // internship host's sign-in page. The success path redirects to the IdP.
  const origin = requestOrigin((n) => req.headers.get(n));
  const org = await prisma.organization.findUnique({ where: { slug } });
  if (!org || !isSsoActive(org)) {
    return NextResponse.redirect(`${origin}/auth/signin?error=sso_unavailable`);
  }
  try {
    const saml = samlForOrg(slug, org);
    // The ACS the IdP posts back to is REGISTERED there under NEXTAUTH_URL's
    // host, so the browser returns to that host whichever one it left from.
    // RelayState is SAML's own "where was I" slot (echoed verbatim by the IdP,
    // ≤ 80 bytes by the spec — an origin is ~30): the ACS reads it back through
    // servedOrigin() and finishes the sign-in on the host the user started on
    // (#2494). Sent only when that host is not the configured one, so a tenant
    // signing in on the internship host sends exactly the AuthnRequest it
    // always did.
    const relayState = origin === configuredOrigin() ? '' : origin;
    const url = await saml.getAuthorizeUrlAsync(relayState, undefined, {});
    return NextResponse.redirect(url);
  } catch (e) {
    console.error('SSO login init failed:', e);
    return NextResponse.redirect(`${origin}/auth/signin?error=sso_failed`);
  }
}
