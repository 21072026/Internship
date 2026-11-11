import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isSsoActive } from '@/lib/sso';
import { completeOidcLogin, mapOidcClaims, OIDC_STATE_COOKIE, spendOidcRequest } from '@/lib/ssoOidc';
import { extractClaims } from '@/lib/ssoRoleMapping';
import { completeSsoSignIn, landingOrigin, ssoFail } from '@/lib/ssoCompletion';
import { enforceRateLimit } from '@/lib/rateLimit';
import { logActivity } from '@/lib/activity';

// GET /api/auth/sso/[slug]/callback — the OIDC redirect URI (#1929). The IdP
// sends the browser back here with `code` and `state`. In this order:
//   1. the tenant must be an active OIDC tenant;
//   2. the request row named by `state` is SPENT (single use, this org,
//      unexpired) before anything else is trusted;
//   3. a login started on this very host must come back to the browser that
//      started it (the state cookie) — login CSRF;
//   4. the code is exchanged with the PKCE verifier and the ID token VERIFIED
//      (src/lib/ssoOidc.ts: signature, iss, aud/azp, exp, nonce);
//   5. completeSsoSignIn() — the same provisioning and single-use grant the
//      SAML ACS uses.
// Every refusal lands on /auth/signin?error=… — never a 500, never a session.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const limited = enforceRateLimit(req, 'sso-callback', { limit: 30, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;

  const q = new URL(req.url).searchParams;
  const state = q.get('state');
  const code = q.get('code');

  const org = await prisma.organization.findUnique({ where: { slug } });
  if (!org || !isSsoActive(org) || org.ssoProvider !== 'oidc') {
    return ssoFail('sso_unavailable', await landingOrigin(org?.id, null));
  }
  const request = state ? await spendOidcRequest(state, org.id) : null;
  const origin = await landingOrigin(org.id, request?.returnOrigin ?? null);
  const refuse = async (reason: string, why: string) => {
    await logActivity({ action: 'sso.oidc_failed', level: 'warning', targetType: 'organization', targetId: org.id, detail: why.slice(0, 180) });
    const res = ssoFail(reason, origin);
    res.cookies.delete({ name: OIDC_STATE_COOKIE, path: '/api/auth/sso' });
    return res;
  };

  if (!request) return refuse('sso_failed', 'unknown, used or expired state');
  // The IdP reports a refusal (the person cancelled, the app is not assigned
  // to them) as `error` instead of a code.
  if (q.get('error')) return refuse('sso_failed', `IdP error: ${q.get('error')}`);
  if (!code) return refuse('sso_failed', 'no authorization code');
  // A login started on this host (no returnOrigin) set the cookie on this host,
  // so its absence or a mismatch means the callback URL was carried to a
  // browser that did not start the login. A login started on another served
  // host cannot carry a cookie here; it rests on the single-use state alone,
  // exactly as a SAML RelayState does.
  if (!request.returnOrigin) {
    const cookie = req.headers.get('cookie') ?? '';
    const sent = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${OIDC_STATE_COOKIE}=`))?.slice(OIDC_STATE_COOKIE.length + 1);
    if (!sent || decodeURIComponent(sent) !== state) return refuse('sso_failed', 'state not bound to this browser');
  }

  let identity: { email: string; fullName: string | null };
  let claims: Record<string, unknown>;
  try {
    claims = await completeOidcLogin(org, code, request);
    identity = mapOidcClaims(claims);
  } catch (e) {
    return refuse('sso_failed', e instanceof Error ? e.message : 'verification failed');
  }

  const { response, userId } = await completeSsoSignIn(org, { ...identity, claims: extractClaims(claims) }, origin);
  if (userId) {
    await logActivity({ action: 'sso.oidc_login', actorId: userId, targetType: 'organization', targetId: org.id });
  }
  response.cookies.delete({ name: OIDC_STATE_COOKIE, path: '/api/auth/sso' });
  return response as NextResponse;
}
