import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { samlForOrg } from '@/lib/ssoSaml';
import { requestOrigin } from '@/lib/servedHosts';

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
    const url = await saml.getAuthorizeUrlAsync('', undefined, {});
    return NextResponse.redirect(url);
  } catch (e) {
    console.error('SSO login init failed:', e);
    return NextResponse.redirect(`${origin}/auth/signin?error=sso_failed`);
  }
}
