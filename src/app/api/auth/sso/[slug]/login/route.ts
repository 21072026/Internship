import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { samlForOrg } from '@/lib/ssoSaml';
import { requestOrigin } from '@/lib/servedHosts';
import { worldForHeaders } from '@/lib/hostWorld';
import { worldOfOrg } from '@/lib/userWorld';

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
  // An org code of the OTHER product is refused exactly like an unknown one: an
  // action stays in the world it was started in (docs/worlds.md), and the ACS
  // lands on the org's own world — so starting here would end the sign-in in
  // the other product. The same answer also keeps this host from confirming
  // which codes exist over there. Guarding the entry is enough: every
  // AuthnRequest now starts on a host of the org's world, which is where the
  // ACS's landingOrigin(org.id) sends the browser back to.
  if ((await worldOfOrg(org.id)) !== worldForHeaders((n) => req.headers.get(n))) {
    return NextResponse.redirect(`${origin}/auth/signin?error=sso_unavailable`);
  }
  try {
    const saml = samlForOrg(slug, org);
    const url = await saml.getAuthorizeUrlAsync('', undefined, {});
    return NextResponse.redirect(url);
  } catch (e) {
    console.error('SSO login init failed:', e);
    return NextResponse.redirect(`${origin}/auth/signin?error=sso_failed`);
  }
}
