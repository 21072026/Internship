import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { beginAuthorization, OIDC_REQUEST_TTL_MS } from '@/lib/ssoOidc';
import { configuredOrigin, requestOrigin } from '@/lib/servedHosts';
import { worldForHeaders } from '@/lib/hostWorld';
import { defaultOrgId } from '@/lib/defaultOrg';
import { SOCIAL_STATE_COOKIE, socialClient, socialKind, socialProvider } from '@/lib/socialSignIn';
import { enforceRateLimit } from '@/lib/rateLimit';

// Social sign-in, step 1 (#1962): send the browser to the provider. The flow is
// the tenant-SSO OIDC engine with the provider's client (src/lib/socialSignIn.ts).
//
// A provider that is not configured (feature flag off, or no credentials) is a
// 404 — the same answer as a provider that does not exist, and the screens do
// not draw its button either. The INTERNSHIP world only: the marketing product
// is invitation-only, and its host answers 404 too.
//
// `?link=1` is "connect this provider to my account" from account settings: it
// needs a signed-in, non-impersonated session, and the request row records
// that account (linkUserId) — the callback then links whatever the provider
// asserts, because the person already proved who they are with their own
// password. Never from a body or a query value.

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const limited = enforceRateLimit(req, 'social-login', { limit: 30, windowMs: 10 * 60 * 1000 });
  if (limited) return limited;
  const { provider: id } = await params;
  const origin = requestOrigin((n) => req.headers.get(n));
  const provider = socialProvider(id);
  if (!provider || worldForHeaders((n) => req.headers.get(n)) !== 'INTERNSHIP') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let linkUserId: string | null = null;
  if (new URL(req.url).searchParams.get('link') === '1') {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || session.user.impersonatorId) {
      return NextResponse.redirect(`${origin}/auth/signin?error=social_link_requires_session`);
    }
    linkUserId = session.user.id;
  }

  try {
    const { url, state } = await beginAuthorization(socialClient(provider), {
      orgId: await defaultOrgId(),
      kind: socialKind(provider.id),
      returnOrigin: origin === configuredOrigin() ? null : origin,
      linkUserId,
    });
    const res = NextResponse.redirect(url);
    // Bound to THIS browser (login CSRF), exactly like the SSO OIDC login.
    res.cookies.set(SOCIAL_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: origin.startsWith('https://'),
      path: '/api/auth/social',
      maxAge: Math.floor(OIDC_REQUEST_TTL_MS / 1000),
    });
    return res;
  } catch (e) {
    console.error('Social login init failed:', e instanceof Error ? e.message : e);
    return NextResponse.redirect(`${origin}/auth/signin?error=social_failed`);
  }
}
