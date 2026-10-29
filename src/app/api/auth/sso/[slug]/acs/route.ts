import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { samlForOrg, mapSamlProfile } from '@/lib/ssoSaml';
import { extractClaims, type SsoClaims } from '@/lib/ssoRoleMapping';
import { completeSsoSignIn, landingOrigin, ssoFail as fail } from '@/lib/ssoCompletion';

// POST /api/auth/sso/[slug]/acs — the Assertion Consumer Service. The IdP posts
// the signed SAML response here (via the browser). We verify the signature
// against the tenant's stored certificate, then hand the verified identity to
// completeSsoSignIn() (src/lib/ssoCompletion.ts) — JIT provisioning and the
// single-use grant the `sso` NextAuth provider consumes, shared with OIDC.
// Where the browser lands (the RelayState rules) is landingOrigin() there.
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // The form is read first so that the refusals below can honour RelayState too.
  let SAMLResponse: string | null = null;
  let RelayState = '';
  try {
    const form = await req.formData();
    const r = form.get('SAMLResponse');
    SAMLResponse = typeof r === 'string' ? r : null;
    const rs = form.get('RelayState');
    RelayState = typeof rs === 'string' ? rs : '';
  } catch {
    return fail('sso_failed');
  }

  const org = await prisma.organization.findUnique({ where: { slug } });
  // An OIDC tenant has no ACS: a SAML response posted here for it is refused
  // like an inactive tenant's.
  if (!org || !isSsoActive(org) || org.ssoProvider !== 'saml') return fail('sso_unavailable', await landingOrigin(org?.id, RelayState));
  const origin = await landingOrigin(org.id, RelayState);
  if (!SAMLResponse) return fail('sso_failed', origin);

  let email: string;
  let fullName: string | null;
  let claims: SsoClaims;
  try {
    const saml = samlForOrg(slug, org);
    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse, RelayState });
    const identity = mapSamlProfile(profile as Record<string, unknown> | null);
    email = identity.email;
    fullName = identity.fullName;
    // Only from a VERIFIED profile: the claims decide a role (#1940).
    claims = extractClaims(profile as Record<string, unknown> | null);
  } catch (e) {
    console.error('SSO assertion validation failed:', e);
    return fail('sso_failed', origin);
  }

  return (await completeSsoSignIn(org, { email, fullName, claims }, origin)).response;
}
