import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { samlForOrg, mapSamlProfile } from '@/lib/ssoSaml';
import { provisionSsoUser } from '@/lib/ssoProvisioning';
import { worldOfOrg } from '@/lib/userWorld';
import { originForWorld, worldForHostHeader } from '@/lib/hostWorld';
import { servedOrigin } from '@/lib/servedHosts';

const base = () => (process.env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');

// Where the browser goes after the IdP posted here. The IdP always posts to the
// ACS URL it has registered (NEXTAUTH_URL's host), but the SESSION has to be
// minted on the host of the product the organization lives in (#2590): the
// `sso` provider refuses an account whose world is not the host's, and it
// burns the single-use grant BEFORE refusing — so handing a marketing
// organization's grant to the internship host would waste it and sign nobody
// in. An internship organization keeps `base()` exactly as before; only a
// marketing organization is sent to the marketing host.
//
// Within that world, the host the sign-in STARTED on wins (#2494): the login
// route puts that origin into RelayState, so a sign-in begun on another host
// of the same product finishes there. RelayState is unsigned and chosen by
// whoever makes the browser POST here, so it is honoured only through
// servedOrigin() (a bare origin of a host this deployment serves, exact match —
// no open redirect) AND only when that host belongs to the organization's own
// world; anything else falls back to the world's origin as before. With no
// organization at all (an unknown slug) there is only a refusal to show and no
// grant to strand, so any served origin will do.
async function landingOrigin(orgId: string | null | undefined, relayState: string | null): Promise<string> {
  const world = await worldOfOrg(orgId);
  const started = servedOrigin(relayState);
  if (started && (!orgId || worldForHostHeader(new URL(started).host) === world)) return started;
  if (world === 'MARKETING') return originForWorld('MARKETING');
  return base();
}
const fail = (reason: string, origin: string = base()) =>
  NextResponse.redirect(`${origin}/auth/signin?error=${reason}`, 303);

// POST /api/auth/sso/[slug]/acs — the Assertion Consumer Service. The IdP posts
// the signed SAML response here (via the browser). We verify the signature
// against the tenant's stored certificate, JIT-provision the user, then hand off
// to the `sso` NextAuth provider via a single-use grant to issue the session.
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
  if (!org || !isSsoActive(org)) return fail('sso_unavailable', await landingOrigin(org?.id, RelayState));
  const origin = await landingOrigin(org.id, RelayState);
  if (!SAMLResponse) return fail('sso_failed', origin);

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
    return fail('sso_failed', origin);
  }

  try {
    const { user } = await provisionSsoUser({ orgId: org.id, email, fullName });
    // Mint a short-lived single-use grant the `sso` provider will consume.
    const token = crypto.randomBytes(32).toString('hex');
    await prisma.ssoLoginGrant.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + 2 * 60 * 1000) },
    });
    return NextResponse.redirect(`${origin}/auth/sso/complete?token=${token}`, 303);
  } catch (e) {
    // e.g. the email already belongs to a different tenant.
    console.error('SSO provisioning failed:', e);
    return fail('sso_conflict', origin);
  }
}
