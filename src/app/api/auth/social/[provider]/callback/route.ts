import { NextResponse } from 'next/server';
import { exchangeAndVerify, spendOidcRequest } from '@/lib/ssoOidc';
import { configuredOrigin, servedOrigin } from '@/lib/servedHosts';
import { defaultOrgId } from '@/lib/defaultOrg';
import { logActivity } from '@/lib/activity';
import { createLoginLinkToken } from '@/lib/magicLink';
import { socialIdentityFrom } from '@/lib/socialProvidersRule';
import { resolveSocialSignIn, sealConsentTicket, SOCIAL_CONSENT_COOKIE, SOCIAL_CONSENT_TTL_MS, SOCIAL_STATE_COOKIE, socialClient, socialKind, socialProvider } from '@/lib/socialSignIn';
import { enforceRateLimit } from '@/lib/rateLimit';

// Social sign-in, step 2 (#1962): the provider sends the browser back here.
//
//   1. The single-use request row is spent (conditional updateMany — a replayed
//      or raced state finds nothing) and, when the login started on this host,
//      bound to this browser's state cookie (login CSRF).
//   2. The code is exchanged and the ID token VERIFIED by the tenant-SSO
//      engine: signature against the provider's JWKS, issuer, audience, expiry,
//      nonce, PKCE.
//   3. THE linking rule (socialProvidersRule.ts) names the account — a known
//      subject, a connect request, or a match on a VERIFIED email only.
//   4. A NEW account is not created here: the consent page asks first
//      (/auth/social/consent → POST /api/auth/social/consent).
//   5. No session is minted here. A single-use sign-in link is, and the
//      browser redeems it through the `magic` provider — the door that applies
//      every account rule, including the account's own second factor.

function fail(origin: string, reason: string) {
  const res = NextResponse.redirect(`${origin}/auth/signin?error=social_${reason}`, 303);
  res.cookies.delete({ name: SOCIAL_STATE_COOKIE, path: '/api/auth/social' });
  return res;
}

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const limited = enforceRateLimit(req, 'social-callback', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const { provider: id } = await params;
  const provider = socialProvider(id);
  if (!provider) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const q = new URL(req.url).searchParams;
  const state = q.get('state');
  const code = q.get('code');
  const request = state ? await spendOidcRequest(state, await defaultOrgId(), socialKind(provider.id)) : null;
  // The host the sign-in started on, honoured only when this deployment serves it.
  const origin = servedOrigin(request?.returnOrigin ?? null) ?? configuredOrigin();
  const refuse = async (reason: string, why: string) => {
    await logActivity({ action: 'auth.social_failed', level: 'warning', detail: `${provider.id}: ${why}`.slice(0, 180) });
    return fail(origin, reason);
  };

  if (!request) return refuse('failed', 'unknown, used or expired state');
  if (q.get('error')) return refuse('failed', `provider error: ${q.get('error')}`);
  if (!code) return refuse('failed', 'no authorization code');
  if (!request.returnOrigin) {
    const cookie = req.headers.get('cookie') ?? '';
    const sent = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SOCIAL_STATE_COOKIE}=`))?.slice(SOCIAL_STATE_COOKIE.length + 1);
    if (!sent || decodeURIComponent(sent) !== state) return refuse('failed', 'state not bound to this browser');
  }

  let identity;
  try {
    identity = socialIdentityFrom(provider.id, await exchangeAndVerify(socialClient(provider), code, request));
  } catch (e) {
    return refuse('failed', e instanceof Error ? e.message : 'verification failed');
  }
  if (!identity) return refuse('failed', 'the ID token names no subject');

  const outcome = await resolveSocialSignIn(provider.id, identity, request.linkUserId ?? null);
  if (outcome.kind === 'refuse') return refuse(outcome.reason, outcome.reason);
  if (outcome.kind === 'pending') return fail(origin, 'pending_approval');
  if (outcome.kind === 'linked') {
    const res = NextResponse.redirect(`${origin}/account?linked=${provider.id}`, 303);
    res.cookies.delete({ name: SOCIAL_STATE_COOKIE, path: '/api/auth/social' });
    return res;
  }
  if (outcome.kind === 'needs_consent') {
    // A new account: the consent page asks first (createSocialAccount). The
    // verified identity rides in a sealed, httpOnly cookie, bound to this
    // browser — never in the URL.
    const res = NextResponse.redirect(`${origin}/auth/social/consent`, 303);
    res.cookies.delete({ name: SOCIAL_STATE_COOKIE, path: '/api/auth/social' });
    res.cookies.set(SOCIAL_CONSENT_COOKIE, sealConsentTicket(provider.id, identity), {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https://'),
      path: '/api/auth/social',
      maxAge: Math.floor(SOCIAL_CONSENT_TTL_MS / 1000),
    });
    return res;
  }
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const token = await createLoginLinkToken(outcome.userId, ip);
  const res = NextResponse.redirect(`${origin}/auth/magic/complete?token=${encodeURIComponent(token)}`, 303);
  res.cookies.delete({ name: SOCIAL_STATE_COOKIE, path: '/api/auth/social' });
  return res;
}
