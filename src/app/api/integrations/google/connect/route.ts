import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { randomBytes } from 'crypto';
import { authOptions } from '@/lib/auth';
import { googleConsentUrl, isGoogleCalendarEnabled } from '@/lib/googleCalendar';
import { makeState } from '@/lib/googleOAuthState';

// GET — start the user-consented Google Calendar connect flow (#709).
// A redirect, not JSON: the browser has to land on Google's consent screen.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.redirect(new URL('/auth/signin', process.env.NEXTAUTH_URL || 'http://localhost:3000'));

  const base = process.env.NEXTAUTH_URL || 'http://localhost:3000';
  // Enabled, not merely configured: credentials can sit in the env long before
  // the operator wants meetings flowing into real calendars.
  if (!isGoogleCalendarEnabled()) {
    return NextResponse.redirect(new URL('/account?google=unavailable', base));
  }

  const state = makeState(session.user.id, randomBytes(12).toString('hex'));
  const url = googleConsentUrl(state);
  if (!url) return NextResponse.redirect(new URL('/account?google=unavailable', base));
  return NextResponse.redirect(url);
}
