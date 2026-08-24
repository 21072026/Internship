import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { verifyState } from '@/lib/googleOAuthState';
import { emailFromIdToken, exchangeCode, saveConnection } from '@/lib/googleCalendarClient';
import { logActivity } from '@/lib/activity';

// GET — Google redirects the user back here with `code` and `state` (#709).
export async function GET(request: Request) {
  const base = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  const back = (status: string) => NextResponse.redirect(new URL(`/account?google=${status}`, base));

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.redirect(new URL('/auth/signin', base));
  if (!isGoogleCalendarEnabled()) return back('unavailable');

  const url = new URL(request.url);
  // The user pressed "Cancel" on Google's screen. Not an error — say nothing
  // alarming, just take them back.
  if (url.searchParams.get('error')) return back('cancelled');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return back('failed');

  const verified = verifyState(state);
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
