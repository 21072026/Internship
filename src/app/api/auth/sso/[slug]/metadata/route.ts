import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { spMetadataXml } from '@/lib/ssoSaml';
import { ensureSpSigningKey } from '@/lib/ssoSpKey';

// GET /api/auth/sso/[slug]/metadata — our SAML SP metadata for one tenant, so
// the customer's identity team imports it in one click instead of copying the
// Entity ID and ACS URL out of docs/sso-saml.md (#1931). Public (pre-auth) by
// nature, like the login and acs routes: it exposes only the URLs we already
// publish, the NameID format and our PUBLIC signing certificate (#1952) — no
// secret and no tenant data.
//
// Deliberately NOT gated on isSsoActive — metadata is what IT needs *while*
// configuring, i.e. exactly before SSO is enabled. Unknown slug is a 404 so a
// typo is distinguishable from a working tenant.
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const limited = enforceRateLimit(request, 'sso-metadata', { limit: 30, windowMs: 60 * 1000 });
  if (limited) return limited;

  const { slug } = await params;
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, slug: true, ssoSpKey: true, ssoSpCert: true, ssoSignRequests: true },
  });
  if (!org) return new NextResponse('Not found', { status: 404 });

  // Our signing certificate for Single Logout (#1952), created here on the
  // org's first metadata fetch — the moment an IdP first needs it. One
  // conditional write, ever (src/lib/ssoSpKey.ts), behind the rate limit above.
  const { certificatePem } = await ensureSpSigningKey(org);

  return new NextResponse(spMetadataXml(slug, certificatePem, { authnRequestsSigned: org.ssoSignRequests }), {
    headers: {
      'Content-Type': 'application/samlmetadata+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
