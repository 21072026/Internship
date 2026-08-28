import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { enrolTrustedDevice, readRememberToken, revokeTrustedDeviceByToken } from '@/lib/trustedDevice';
import { clearRememberCookies, setRememberCookies } from '@/lib/rememberCookie';
import { enforceRateLimit } from '@/lib/rateLimit';

/**
 * POST — "remember this device". Called by the sign-in form right after a
 * successful sign-in when the user ticked the box.
 *
 * Enrolment is a separate call rather than part of authorize() because a
 * NextAuth provider cannot write a cookie: it returns a user, not a response.
 * Requiring a valid session here is exactly the right authority — whoever just
 * proved the password (and the TOTP code) may say "trust this browser".
 */
export async function POST(request: Request) {
  // Per IP, and a whole office can share one — so the ceiling is well above any
  // honest sign-in rate. This is anti-abuse, not a quota.
  const limited = enforceRateLimit(request, 'remember-enrol', { limit: 60, windowMs: 60 * 60 * 1000 });
  if (limited) return limited;

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Never from an impersonation session: the admin's browser would otherwise
  // hold a 90-day credential for somebody else's account (#1039 draws the same
  // line for "sign out of all devices").
  if (session.user.impersonatorId) {
    return NextResponse.json({ error: 'Not available while impersonating' }, { status: 400 });
  }

  // Signing in again in a browser that is already remembered replaces its
  // device rather than adding a second one: the old cookie is about to be
  // overwritten anyway, and an unreachable row would still occupy one of the
  // ten slots per account.
  const existing = await readRememberToken();
  if (existing) await revokeTrustedDeviceByToken(existing);

  const { token, expiresAt } = await enrolTrustedDevice(session.user.id, request);
  const res = NextResponse.json({ ok: true, expiresAt: expiresAt.toISOString() });
  setRememberCookies(res, token, expiresAt);
  return res;
}

/**
 * DELETE — "forget this device". Called just before signing out, so a
 * deliberate sign-out is not undone by the very next page load. Needs no
 * session: presenting the cookie is enough to give it up, and being able to
 * revoke only your own remembered device does no harm.
 */
export async function DELETE() {
  const token = await readRememberToken();
  if (token) await revokeTrustedDeviceByToken(token);
  const res = NextResponse.json({ ok: true });
  clearRememberCookies(res);
  return res;
}
