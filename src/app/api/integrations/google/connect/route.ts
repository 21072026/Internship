import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { randomBytes } from 'crypto';
import { authOptions } from '@/lib/auth';
import { googleConsentUrl, isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { makeState } from '@/lib/googleOAuthState';
import { configuredOrigin, requestOrigin } from '@/lib/servedHosts';

// GET — start the user-consented Google Calendar connect flow (#709).
// A redirect, not JSON: the browser has to land on Google's consent screen.
export async function GET(request: Request) {
  // Same-app redirects stay on the host the browser is on (#2488); the Google
  // consent URL and its registered redirect_uri are untouched.
  const base = requestOrigin((n) => request.headers.get(n));
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.redirect(new URL('/auth/signin', base));

  // Enabled, not merely configured: credentials can sit in the env long before
  // the operator wants meetings flowing into real calendars.
  if (!isGoogleCalendarEnabled()) {
    return NextResponse.redirect(new URL('/account?google=unavailable', base));
  }

  // Google returns the browser to the redirect_uri registered with it — the
  // configured host. A flow started anywhere else signs its origin into the
  // state, so the callback can hand it back to where the session lives (#2494).
  const origin = base === configuredOrigin() ? null : base;
  const state = makeState(session.user.id, randomBytes(12).toString('hex'), Date.now(), origin);
  const url = googleConsentUrl(state);
  if (!url) return NextResponse.redirect(new URL('/account?google=unavailable', base));
  return NextResponse.redirect(url);
}
