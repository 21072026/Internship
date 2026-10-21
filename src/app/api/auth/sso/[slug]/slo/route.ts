import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';
import { isSsoActive } from '@/lib/sso';
import type { Profile } from '@node-saml/node-saml';
import { samlLogoutForOrg } from '@/lib/ssoSaml';
import { ensureSpSigningKey } from '@/lib/ssoSpKey';
import { endAllSessionsForSlo } from '@/lib/ssoLogout';
import { requestOrigin } from '@/lib/servedHosts';
import { parseRedirectBinding } from '@/lib/samlRedirectQuery';

// GET|POST /api/auth/sso/[slug]/slo — our SAML SingleLogoutService (#1952),
// published in the SP metadata. Two kinds of message arrive here:
//
//   • a LogoutRequest — IdP-initiated: the person signed out at their IdP (or
//     another SP), and the IdP tells us to end their session. We end EVERY
//     session and remembered device of that person in this org
//     (src/lib/ssoLogout.ts says why it is all of them) and answer with a
//     signed LogoutResponse to the IdP's SLO endpoint;
//   • a LogoutResponse — the IdP's answer to a LogoutRequest WE sent from
//     POST /api/auth/sso/logout. The local sign-out already happened before we
//     sent it, so all that is left is to land the browser on the sign-in page.
//
// NEVER ACT ON AN UNVERIFIED REQUEST. This endpoint is public by nature, and a
// logout anyone could forge is a way to sign every user out at will. So:
//   – HTTP-Redirect: the query MUST carry `Signature` + `SigAlg`, verified
//     against the org's stored IdP certificate. node-saml's validateRedirect
//     treats an ABSENT signature as valid — the refusal of an unsigned
//     redirect is ours, here, before node-saml is asked anything;
//   – HTTP-POST: node-saml requires an enveloped XML signature on the
//     LogoutRequest and verifies it against the same certificate.
// The subject is resolved by NameID → e-mail WITHIN THIS ORG ONLY: a
// LogoutRequest through tenant A's endpoint can never touch tenant B's user.
// An unknown subject still gets a Success response — nothing changes, and the
// answer does not tell the IdP (or anyone replaying through it) who exists.
//
// Rate-limited per IP: verification costs an RSA operation per request.

const SLO_LIMIT = { limit: 30, windowMs: 60 * 1000 };

type Message = { SAMLRequest?: string; SAMLResponse?: string; RelayState?: string; Signature?: string; SigAlg?: string };

async function handle(
  request: Request,
  slug: string,
  binding: 'redirect' | 'post',
  msg: Message,
  rawQuery: string,
  malformed?: string,
) {
  const origin = requestOrigin((n) => request.headers.get(n));
  const signedOut = () => NextResponse.redirect(`${origin}/auth/signin`, 303);

  const org = await prisma.organization.findUnique({
    where: { slug },
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
  if (!org || !isSsoActive(org)) return NextResponse.json({ code: 'sso_unavailable' }, { status: 404 });

  const { privateKeyPem } = await ensureSpSigningKey(org);
  const saml = samlLogoutForOrg(slug, org, privateKeyPem);

  const refuse = async (reason: string) => {
    await logActivity({
      action: 'auth.slo_refused',
      level: 'warning',
      targetType: 'Organization',
      targetId: org.id,
      orgId: org.id,
      detail: `${binding}: ${reason}`,
      request,
    });
    return NextResponse.json({ code: 'slo_refused', error: 'The logout request could not be verified' }, { status: 400 });
  };
  // A redirect query with a repeated or unreadable binding parameter is never
  // read at all (src/lib/samlRedirectQuery.ts says why).
  if (malformed) return refuse(malformed);

  // The IdP's answer to our LogoutRequest. We were already signed out locally;
  // a response that does not verify changes nothing either way.
  if (!msg.SAMLRequest) {
    if (msg.SAMLResponse && binding === 'redirect' && msg.Signature) {
      await saml.validateRedirectAsync(msg as Record<string, string>, rawQuery).catch(() => null);
    }
    return signedOut();
  }

  let profile: Profile | null;
  try {
    if (binding === 'redirect') {
      if (!msg.Signature || !msg.SigAlg) return refuse('unsigned');
      ({ profile } = await saml.validateRedirectAsync(msg as Record<string, string>, rawQuery));
    } else {
      ({ profile } = await saml.validatePostRequestAsync({ SAMLRequest: msg.SAMLRequest }));
    }
  } catch (e) {
    return refuse(e instanceof Error ? e.message.slice(0, 120) : 'invalid');
  }
  const email = profile?.nameID?.trim().toLowerCase();
  if (!profile || !email) return refuse('no subject');

  const user = await prisma.user.findFirst({ where: { orgId: org.id, email }, select: { id: true, email: true } });
  if (user) {
    await endAllSessionsForSlo(user.id);
    await logActivity({
      action: 'auth.slo',
      targetType: 'User',
      targetId: user.id,
      actorEmail: user.email,
      orgId: org.id,
      detail: 'IdP-initiated: sessions and remembered devices ended',
      request,
    });
  }

  // A signed LogoutResponse back to the IdP's SLO endpoint. Without one on
  // file there is nowhere to send it (node-saml would fall back to the SIGN-IN
  // entry point, which is wrong), so the browser lands on our sign-in page.
  if (!org.ssoLogoutUrl) return signedOut();
  const url = await saml.getLogoutResponseUrlAsync(profile, msg.RelayState ?? '', {}, true);
  return NextResponse.redirect(url, 303);
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const limited = enforceRateLimit(request, 'sso-slo', SLO_LIMIT);
  if (limited) return limited;
  const { slug } = await params;
  // Signed bytes and parsed message from the SAME tokens: never
  // `url.searchParams`, which keeps the LAST of a repeated key while node-saml
  // verifies the FIRST.
  const parsed = parseRedirectBinding(new URL(request.url).search);
  if (typeof parsed === 'string') return handle(request, slug, 'redirect', {}, '', parsed);
  return handle(request, slug, 'redirect', parsed.message, parsed.canonicalQuery);
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const limited = enforceRateLimit(request, 'sso-slo', SLO_LIMIT);
  if (limited) return limited;
  const { slug } = await params;
  let msg: Message = {};
  try {
    const form = await request.formData();
    const pick = (k: string) => {
      const v = form.get(k);
      return typeof v === 'string' ? v : undefined;
    };
    msg = { SAMLRequest: pick('SAMLRequest'), SAMLResponse: pick('SAMLResponse'), RelayState: pick('RelayState') };
  } catch {
    return NextResponse.json({ code: 'slo_refused' }, { status: 400 });
  }
  return handle(request, slug, 'post', msg, '');
}
