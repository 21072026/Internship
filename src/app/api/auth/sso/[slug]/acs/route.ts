import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { samlForOrg, mapSamlProfile } from '@/lib/ssoSaml';
import { provisionSsoUser } from '@/lib/ssoProvisioning';

const base = () => (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
const fail = (reason: string) => NextResponse.redirect(`${base()}/auth/signin?error=${reason}`, 303);

// POST /api/auth/sso/[slug]/acs — the Assertion Consumer Service. The IdP posts
// the signed SAML response here (via the browser). We verify the signature
// against the tenant's stored certificate, JIT-provision the user, then hand off
// to the `sso` NextAuth provider via a single-use grant to issue the session.
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const org = await prisma.organization.findUnique({ where: { slug } });
  if (!org || !isSsoActive(org)) return fail('sso_unavailable');

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
  if (!SAMLResponse) return fail('sso_failed');

  let email: string;
  let fullName: string | null;
  try {
    const saml = samlForOrg(slug, org);
    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse, RelayState });
    const identity = mapSamlProfile(profile as Record<string, unknown> | null);
    email = identity.email;
    fullName = identity.fullName;
  } catch (e) {
    console.error('SSO assertion validation failed:', e);
    return fail('sso_failed');
  }

  try {
    const { user } = await provisionSsoUser({ orgId: org.id, email, fullName });
    // Mint a short-lived single-use grant the `sso` provider will consume.
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.ssoLoginGrant.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + 2 * 60 * 1000) },
    });
    return NextResponse.redirect(`${base()}/auth/sso/complete?token=${token}`, 303);
  } catch (e) {
    // e.g. the email already belongs to a different tenant.
    console.error('SSO provisioning failed:', e);
    return fail('sso_conflict');
  }
}
