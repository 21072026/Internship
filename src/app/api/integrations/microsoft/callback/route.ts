import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { isMicrosoftCalendarEnabled } from '@/lib/microsoftCalendar';
import { verifyState } from '@/lib/googleOAuthState';
import { exchangeMicrosoftCode, microsoftAccountEmail, saveMicrosoftConnection } from '@/lib/microsoftCalendarClient';
import { logActivity } from '@/lib/activity';
import { requestOrigin, servedOrigin } from '@/lib/servedHosts';

// GET — Microsoft redirects the user back here with `code` and `state` (#1991).
// Every rule of the Google callback holds here, for the same reasons (see
// src/app/api/integrations/google/callback/route.ts): a verified state's signed
// origin gets one forwarding hop to the host the session lives on; the state
// must belong to THIS session, so a callback replayed into another browser
// cannot attach one person's Microsoft account to someone else's profile.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');

  const here = requestOrigin((n) => request.headers.get(n));
  const verified = state ? verifyState(state) : null;
  const origin = servedOrigin(verified?.origin ?? null);
  if (origin && origin !== here) {
    return NextResponse.redirect(`${origin}/api/integrations/microsoft/callback${url.search}`);
  }

  const back = (status: string) => NextResponse.redirect(new URL(`/account?microsoft=${status}`, here));

  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.redirect(new URL('/auth/signin', here));
  if (!isMicrosoftCalendarEnabled()) return back('unavailable');

  // The person declined on Microsoft's screen (error=access_denied).
  if (url.searchParams.get('error')) return back('cancelled');

  const code = url.searchParams.get('code');
  if (!code || !state) return back('failed');
  if (!verified || verified.userId !== session.user.id) return back('failed');

  try {
    const tokens = await exchangeMicrosoftCode(code);
    const email = (await microsoftAccountEmail(tokens.access_token)) ?? session.user.email ?? 'unknown';
    await saveMicrosoftConnection(session.user.id, tokens, email);
    await logActivity({
      action: 'microsoft_calendar.connected',
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      targetType: 'user',
      targetId: session.user.id,
      detail: email,
      request,
    });
    return back('connected');
  } catch (e) {
    console.error('Microsoft Calendar connect failed:', e);
    return back('failed');
  }
}
