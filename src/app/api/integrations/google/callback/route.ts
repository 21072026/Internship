import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { verifyState } from '@/lib/googleOAuthState';
import { emailFromIdToken, exchangeCode, saveConnection } from '@/lib/googleCalendarClient';
import { logActivity } from '@/lib/activity';
import { requestOrigin, servedOrigin } from '@/lib/servedHosts';

// GET — Google redirects the user back here with `code` and `state` (#709).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');

  // The host the browser is on (#2488). Google only ever sends it to the
  // redirect_uri registered with it — NEXTAUTH_URL's host — but a connect that
  // started on another served host (the marketing one) signed that origin into
  // the state (#2494). There the user HAS a session; here, with host-only
  // cookies, they have none, so finishing here could only ever bounce them to
  // the wrong product's sign-in page. So: one hop back to the same callback on
  // the originating host, query string untouched, and that request does
  // everything below — the session binding included, which is what makes a
  // forwarded code as safe as one Google delivered there directly. The token
  // exchange sends the REGISTERED redirect_uri from config, not this request's
  // host, so it succeeds from either host.
  //
  // Forwarded only for a state that verifies (we minted it, it has not
  // expired) and only to servedOrigin(): the signature proves the origin is
  // ours, the allowlist that this deployment still serves it. Never forwarded
  // to the host it is already on, so the hop cannot loop.
  const here = requestOrigin((n) => request.headers.get(n));
  const verified = state ? verifyState(state) : null;
  const origin = servedOrigin(verified?.origin ?? null);
  if (origin && origin !== here) {
    return NextResponse.redirect(`${origin}/api/integrations/google/callback${url.search}`);
  }

  const back = (status: string) => NextResponse.redirect(new URL(`/account?google=${status}`, here));

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.redirect(new URL('/auth/signin', here));
  if (!isGoogleCalendarEnabled()) return back('unavailable');

  // The user pressed "Cancel" on Google's screen. Not an error — say nothing
  // alarming, just take them back.
  if (url.searchParams.get('error')) return back('cancelled');

  const code = url.searchParams.get('code');
  if (!code || !state) return back('failed');

  // The state must not merely be valid — it must belong to THIS session. Without
  // that check a callback could be replayed into someone else's browser and
  // attach one person's Google account to another person's profile.
  if (!verified || verified.userId !== session.user.id) return back('failed');

  try {
    const tokens = await exchangeCode(code);
    const email = emailFromIdToken(tokens.id_token) ?? session.user.email ?? 'unknown';
    await saveConnection(session.user.id, tokens, email);
    await logActivity({
      action: 'google_calendar.connected',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: session.user.id,
      detail: email,
      request,
    });
    return back('connected');
  } catch (e) {
    console.error('Google Calendar connect failed:', e);
    return back('failed');
  }
}
