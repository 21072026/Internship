/**
 * Cookie names and writers for "remember me" (#1495).
 *
 * Deliberately free of any Prisma/Node import: `src/middleware.ts` runs on the
 * edge runtime and needs to clear these cookies on sign-out, so this module has
 * to stay importable from there. All database work lives in
 * `src/lib/trustedDevice.ts`.
 */
import type { NextResponse } from 'next/server';
import { REMEMBER_HINT_COOKIE } from '@/lib/rememberHint';

// Mirrors how NextAuth picks its own cookie prefix: the `__Secure-` prefix is
// only legal on an https response, and on a plain-http dev server a browser
// silently drops it — which would look like "remember me does nothing locally".
const useSecureCookies = (process.env.NEXTAUTH_URL || '').startsWith('https://');

const PLAIN = 'internship.remember-token';
const SECURE = '__Secure-internship.remember-token';

/**
 * The long-lived credential. httpOnly + SameSite=Lax: it is never readable from
 * JavaScript, and it does not ride along on cross-site requests (a top-level
 * GET navigation is the only exception, and the refresh endpoint that consumes
 * this cookie is POST-only).
 */
export const REMEMBER_COOKIE = useSecureCookies ? SECURE : PLAIN;

/**
 * Both spellings, for reading and clearing. Same reasoning as
 * `sessionCookie.ts`: check both rather than trusting the env var to be right —
 * a misread env can then only cost a lookup, never leave a cookie behind.
 */
export const REMEMBER_COOKIES = [PLAIN, SECURE] as const;

// Re-exported for the server side; defined in its own module so the client can
// import the name without this file's NEXTAUTH_URL lookup.
export { REMEMBER_HINT_COOKIE };

const BASE = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: useSecureCookies,
  path: '/',
};

export function setRememberCookies(res: NextResponse, token: string, expiresAt: Date) {
  res.cookies.set(REMEMBER_COOKIE, token, { ...BASE, expires: expiresAt });
  res.cookies.set(REMEMBER_HINT_COOKIE, '1', { ...BASE, httpOnly: false, expires: expiresAt });
}

export function clearRememberCookies(res: NextResponse) {
  // Written with maxAge 0 rather than deleted by name: the attributes must
  // match the ones they were set with (notably `path`) or the browser keeps the
  // original cookie.
  for (const name of REMEMBER_COOKIES) {
    res.cookies.set(name, '', { ...BASE, secure: name === SECURE, maxAge: 0 });
  }
  res.cookies.set(REMEMBER_HINT_COOKIE, '', { ...BASE, httpOnly: false, maxAge: 0 });
}
