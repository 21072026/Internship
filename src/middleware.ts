import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { IS_DEMO_MODE, demoBlockReason } from '@/lib/demoMode';
import { REMEMBER_COOKIES, REMEMBER_HINT_COOKIE, clearRememberCookies } from '@/lib/rememberCookie';

// Methods that mutate state. Unverified users are limited to reads.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Endpoints a logged-in-but-unverified user must still be able to call:
// the whole auth surface (sign in/out, forgot/reset, verify + resend).
function isAllowlisted(pathname: string) {
  return (
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/register' ||
    // Returning from impersonation must work even if the impersonated user is
    // unverified (the impersonated identity could be a read-only account).
    pathname === '/api/impersonate/stop' ||
    // Public meeting RSVP (the unguessable token is the credential).
    pathname === '/api/rsvp' ||
    // Public unsubscribe from a mail footer (the signed token IS the credential).
    // Needed for the browser-side POST: a signed-in-but-unverified user — exactly
    // the population most likely to want out of our mail — would otherwise get
    // "Please verify your email address to make changes." on their own opt-out.
    // Gmail's anonymous one-click POST already passed (token === null falls
    // through), but a person clicking the link in a logged-in tab did not.
    // Written as exact-or-subpath rather than a bare `startsWith`, the same
    // shape as '/api/auth/' above: a plain prefix would also allowlist a future
    // sibling like /api/unsubscribe-all, silently exempting it from the
    // verification gate. The three routes that belong here are the collection
    // itself, /one-click and /prefs.
    pathname === '/api/unsubscribe' ||
    pathname.startsWith('/api/unsubscribe/') ||
    // Public mentee application form.
    pathname === '/api/apply' ||
    // Public profile view counter.
    pathname === '/api/profile-view' ||
    // Inbound email bridge (authenticated by HMAC reply token + shared secret).
    pathname === '/api/inbound-email'
  );
}

// The cookie NextAuth keeps the JWT in, both spellings (https gets the
// `__Secure-` prefix). Same list as lib/sessionCookie.ts, repeated rather than
// imported because that module uses next/headers, which the edge runtime this
// file runs on does not have.
const SESSION_COOKIES = ['next-auth.session-token', '__Secure-next-auth.session-token'];

/**
 * A page request from a browser that is remembered but has no session — send it
 * through /auth/resume, which trades the device cookie for a session and
 * continues to the page that was asked for (#1495).
 *
 * Done here rather than on the sign-in page so that /auth/signin stays a place
 * to sign in deliberately — possibly as a different person — and so the user
 * keeps the URL they actually wanted instead of landing on a role dashboard.
 *
 * Costs a cookie lookup and nothing else: no database, no token decode, and
 * nobody without a remember cookie is affected. It cannot loop — /auth/* is
 * excluded, and a refusal from the refresh endpoint clears both cookies.
 */
function wantsResume(req: NextRequest, pathname: string): boolean {
  if (req.method !== 'GET' || pathname.startsWith('/api/') || pathname.startsWith('/auth/')) return false;
  if (SESSION_COOKIES.some((name) => req.cookies.get(name))) return false;
  if (req.cookies.get(REMEMBER_HINT_COOKIE)?.value !== '1') return false;
  return REMEMBER_COOKIES.some((name) => req.cookies.get(name));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (wantsResume(req, pathname)) {
    const url = req.nextUrl.clone();
    const next = `${pathname}${req.nextUrl.search}`;
    url.pathname = '/auth/resume';
    url.search = `?next=${encodeURIComponent(next)}`;
    return NextResponse.redirect(url);
  }

  // Safety net for "remember me" (#1495): every sign-out control in the app
  // revokes the trusted device first (see lib/signOutClient.ts), but someone
  // can still POST NextAuth's own sign-out page directly — from a bookmark, or
  // the /api/auth/signout screen. Clearing the cookies here means a sign-out
  // never leaves a credential behind that would silently sign the browser back
  // in. Only the cookies: the edge runtime has no database, so the row is left
  // to expire (it is unreachable without the secret).
  if (req.method === 'POST' && pathname === '/api/auth/signout') {
    const res = NextResponse.next();
    clearRememberCookies(res);
    return res;
  }

  if (!WRITE_METHODS.has(req.method) || isAllowlisted(pathname)) {
    return NextResponse.next();
  }

  // Public demo (#966): writes are allowed by default — a demo where every
  // button 403s demonstrates nothing — except the short list that would end the
  // demo for other visitors, reach outside it, or store arbitrary files. Placed
  // before the token lookup on purpose: the refusal does not depend on who is
  // signed in, and an anonymous caller must not get further than a signed-in
  // one. No-op unless DEMO_MODE=true, so production is untouched.
  if (IS_DEMO_MODE) {
    const reason = demoBlockReason(pathname);
    if (reason) {
      return NextResponse.json(
        { error: `This is a shared demo, so that action is disabled here — it ${reason}.` },
        { status: 403 }
      );
    }
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });

  // Only block when we positively know the email is unverified. Anonymous
  // requests (token === null) are left to each route's own auth check, and
  // older sessions without the field (undefined) are treated as verified.
  if (token && token.emailVerified === false) {
    return NextResponse.json(
      { error: 'Please verify your email address to make changes.' },
      { status: 403 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/:path*',
    // Page requests, for the remembered-device resume above. Everything with a
    // dot in it (/sw.js, /favicon.ico, /manifest.webmanifest) is a file, and
    // /_next, /api and /auth are handled elsewhere or must never be redirected.
    '/((?!api/|_next/|auth/|.*\\.).*)',
  ],
};
