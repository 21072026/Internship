import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { samlLoginForOrg } from '@/lib/ssoSamlLogin';
import { beginOidcLogin, OIDC_REQUEST_TTL_MS, OIDC_STATE_COOKIE } from '@/lib/ssoOidc';
import { configuredOrigin, requestOrigin } from '@/lib/servedHosts';
import { worldForHeaders } from '@/lib/hostWorld';
import { worldOfOrg } from '@/lib/userWorld';
import { verifiedTenantHosts } from '@/lib/hostOrg';

// GET /api/auth/sso/[slug]/login — SP-initiated SSO. Resolve the tenant, and if
// SSO is active build the request for its protocol — a SAML AuthnRequest, or an
// OIDC authorization request (#1929) — and redirect the browser to the IdP.
// Public (pre-auth) by nature. Falls back to the password page when SSO isn't
// active for the tenant, so a wrong/disabled slug never dead-ends.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // The failure redirects stay on the host the browser is on (#2488): a
  // marketing visitor typing an unknown org code used to be bounced to the
  // internship host's sign-in page. The success path redirects to the IdP.
  // A tenant's DNS-verified own domain counts as served too (#1661).
  const origin = requestOrigin((n) => req.headers.get(n), await verifiedTenantHosts(req.headers.get('x-forwarded-host') ?? req.headers.get('host')));
  const org = await prisma.organization.findUnique({ where: { slug } });
  if (!org || !isSsoActive(org)) {
    return NextResponse.redirect(`${origin}/auth/signin?error=sso_unavailable`);
  }
  // An org code of the OTHER product is refused exactly like an unknown one: an
  // action stays in the world it was started in (docs/worlds.md), and a session
  // for that org is bound to its own world, so it could never be used here. The
  // same answer keeps this host from confirming which codes exist over there.
  if ((await worldOfOrg(org.id)) !== worldForHeaders((n) => req.headers.get(n))) {
    return NextResponse.redirect(`${origin}/auth/signin?error=sso_unavailable`);
  }
  if (org.ssoProvider === 'oidc') {
    try {
      // The OIDC twin of RelayState is the request row's returnOrigin; the
      // callback honours it only through servedOrigin(), like the ACS.
      const { url, state } = await beginOidcLogin(org, origin === configuredOrigin() ? null : origin);
      const res = NextResponse.redirect(url);
      // Bind the login to THIS browser (login CSRF): the callback, when it
      // lands on the host that set this cookie, requires it to match. Lax so
      // the IdP's top-level redirect back carries it.
      res.cookies.set(OIDC_STATE_COOKIE, state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: origin.startsWith('https://'),
        path: '/api/auth/sso',
        maxAge: Math.floor(OIDC_REQUEST_TTL_MS / 1000),
      });
      return res;
    } catch (e) {
      console.error('SSO (OIDC) login init failed:', e instanceof Error ? e.message : e);
      return NextResponse.redirect(`${origin}/auth/signin?error=sso_failed`);
    }
  }
  try {
    const saml = await samlLoginForOrg(slug, org);
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
