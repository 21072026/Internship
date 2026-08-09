import { cookies } from 'next/headers';

// The cookie NextAuth stores the JWT in. The `__Secure-` prefix is used when
// NEXTAUTH_URL is https (production and preview); plain http (local dev, and the
// e2e run) gets the unprefixed name. Check both rather than deriving it from the
// env, so a misread env var can only ever cost a lookup — never skip one.
const SESSION_COOKIES = ['next-auth.session-token', '__Secure-next-auth.session-token'];

/**
 * Is there a session cookie on this request at all? (#1197)
 *
 * A cheap gate in front of `getServerSession()`. The public pages — the landing,
 * the feature catalogue, the legal pages — are mostly served to signed-out
 * visitors, and for them the session decode can only ever come back empty. The
 * root layout and `getLocale()` both run one on every single page view, so this
 * removes two JWT decodes per public request (and, for the callers that follow a
 * session with a `user` lookup, the query behind it).
 *
 * This says only that a cookie is *present*, never that it is valid: a forged or
 * expired cookie still reaches `getServerSession()`, which is what actually
 * verifies it. So this is safe to gate on — a false positive costs a lookup, and
 * a false negative is impossible for a genuinely signed-in user.
 */
export async function hasSessionCookie(): Promise<boolean> {
  const store = await cookies();
  return SESSION_COOKIES.some((name) => Boolean(store.get(name)?.value));
}
