/**
 * The one "remember me" constant the browser bundle needs (#1495).
 *
 * Its own module so the sign-in page can import it without pulling in
 * `rememberCookie.ts`, which reads NEXTAUTH_URL to pick the `__Secure-` prefix
 * and has no business in a client bundle.
 *
 * This cookie is a hint, not a credential: it says "a remember-me token was
 * issued to this browser", so the sign-in page knows whether attempting a
 * silent re-authentication is worth a round trip. The token itself is httpOnly
 * and is the only thing the server ever verifies.
 */
export const REMEMBER_HINT_COOKIE = 'internship.remember';
