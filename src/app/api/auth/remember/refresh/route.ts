import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { enforceRateLimit } from '@/lib/rateLimit';
import { readRememberToken, rotateTrustedDevice } from '@/lib/trustedDevice';
import { clearRememberCookies, setRememberCookies } from '@/lib/rememberCookie';

/** How long the bridge token the browser immediately trades in stays usable. */
const GRANT_TTL_MS = 60 * 1000;

/**
 * POST — silent re-authentication from a trusted device (#1495).
 *
 * The session JWT is short-lived by design, so a remembered browser arrives
 * here with no session at all. It presents the remember-me cookie; we verify
 * and rotate it, then hand back a single-use grant that the client trades for a
 * real session through `signIn('remember', …)`.
 *
 * Why the extra hop instead of encoding a JWT right here: every session in this
 * app is minted by the `jwt` callback in lib/auth.ts, which is where the role,
 * tenant, verification flag and the "sign out of all devices" stamp are set. A
 * second place that hand-rolls a token is a second place to forget one of them.
 * Same pattern as the SSO and impersonation grants.
 *
 * Cross-site abuse is not a concern: the cookie is SameSite=Lax so it is not
 * sent on a cross-site POST at all, and the grant comes back in a response body
 * that a cross-origin page cannot read.
 */
export async function POST(request: Request) {
  // Guessing a 256-bit secret is not a threat this limit defends against; it is
  // here so a broken client cannot spin. Generous, because a whole office can
  // arrive from one IP.
  const limited = enforceRateLimit(request, 'remember-refresh', { limit: 120, windowMs: 15 * 60 * 1000 });
  if (limited) return limited;

  const token = await readRememberToken();
  if (!token) {
    // No cookie: not an error, just a browser that was never remembered. 204 so
    // the sign-in page can tell "nothing to do" from "it failed".
    return new NextResponse(null, { status: 204 });
  }

  const result = await rotateTrustedDevice(token, request);
  if (!result.ok) {
    // Expired, revoked, unknown or replayed — in every case this browser's
    // cookie is worthless now, so drop it instead of retrying on every visit.
    const res = NextResponse.json({ error: result.reason }, { status: 401 });
    clearRememberCookies(res);
    return res;
  }

  const grant = randomBytes(32).toString('base64url');
  await prisma.sessionRefreshGrant.create({
    data: {
      token: grant,
      userId: result.userId,
      deviceId: result.deviceId,
      expiresAt: new Date(Date.now() + GRANT_TTL_MS),
    },
  });

  await logActivity({
    action: 'auth.session_refreshed',
    actorId: result.userId,
    targetType: 'TrustedDevice',
    targetId: result.deviceId,
    detail: 'Signed in silently from a remembered device',
    request,
  });

  const res = NextResponse.json({ grant });
  // No token means a concurrent refresh already rotated this device and set the
  // cookie; overwriting it here would undo that.
  if (result.token) setRememberCookies(res, result.token, result.expiresAt);
  return res;
}
