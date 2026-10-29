import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { randomBytes } from 'crypto';
import { authOptions } from '@/lib/auth';
import { isMicrosoftCalendarEnabled, microsoftConsentUrl } from '@/lib/microsoftCalendar';
import { makeState } from '@/lib/googleOAuthState';
import { configuredOrigin, requestOrigin } from '@/lib/servedHosts';

// GET — start the user-consented Microsoft 365 / Outlook connect flow (#1991).
// The same shape as the Google route: a redirect to the consent screen, a
// signed state binding THIS user (lib/googleOAuthState — the HMAC state is
// provider-neutral despite its name), and the origin signed in when the flow
// starts on another served host.
export async function GET(request: Request) {
  const base = requestOrigin((n) => request.headers.get(n));
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.redirect(new URL('/auth/signin', base));

  if (!isMicrosoftCalendarEnabled()) {
    return NextResponse.redirect(new URL('/account?microsoft=unavailable', base));
  }

  const origin = base === configuredOrigin() ? null : base;
  const state = makeState(session.user.id, randomBytes(12).toString('hex'), Date.now(), origin);
  const url = microsoftConsentUrl(state);
  if (!url) return NextResponse.redirect(new URL('/account?microsoft=unavailable', base));
  return NextResponse.redirect(url);
}
