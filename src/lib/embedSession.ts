// The Teams-tab session cookie (#1954, docs/teams-tab-sso.md § decision B).
//
// Edge-safe and dependency-free: src/middleware.ts (edge runtime) and the
// NextAuth route both read it. The rules:
//
//   - A session minted for the Teams tab lives in its OWN cookie, never in
//     NextAuth's: `embed-session` (`__Secure-embed-session` on https), written
//     `HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=8h`. Partitioned
//     (CHIPS) keys it to the Teams top-level site, so it never exists in a
//     first-party tab; NextAuth's own cookie keeps its name and `SameSite=Lax`.
//   - The middleware hands an embed cookie to the server AS the session cookie
//     (request header only) when there is no real session cookie, and marks
//     the request with EMBED_MARKER — stripped from every inbound request first,
//     so a client cannot claim it.
//   - Any Set-Cookie of NextAuth's session cookie on a marked request is
//     rewritten back to the embed cookie, so a session refresh inside Teams can
//     never mint a first-party Lax session.
//   - Off (no CHAT_APPS_ENABLED=1 or no TEAMS_SSO_CLIENT_ID): every function
//     here is a no-op — nothing reads, writes or rewrites the embed cookie.

export const EMBED_SESSION_MAX_AGE_S = 8 * 60 * 60;
export const EMBED_MARKER = 'x-embed-session';
export const EMBED_COOKIES = ['embed-session', '__Secure-embed-session'] as const;
export const SESSION_COOKIE_NAMES = ['next-auth.session-token', '__Secure-next-auth.session-token'] as const;

type Env = Record<string, string | undefined>;

export function isEmbedSessionEnabled(env: Env = process.env): boolean {
  return env.CHAT_APPS_ENABLED === '1' && !!env.TEAMS_SSO_CLIENT_ID;
}

/** NextAuth's secure-cookie rule: https NEXTAUTH_URL → `__Secure-` names. */
export function secureCookies(env: Env = process.env): boolean {
  return (env.NEXTAUTH_URL ?? '').startsWith('https://');
}

export function embedCookieName(secure: boolean): string {
  return secure ? EMBED_COOKIES[1] : EMBED_COOKIES[0];
}

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_NAMES[1] : SESSION_COOKIE_NAMES[0];
}

/** The embed cookie, as one Set-Cookie value. `maxAge` 0 deletes it. */
export function embedSetCookie(value: string, secure: boolean, maxAge = EMBED_SESSION_MAX_AGE_S): string {
  return `${embedCookieName(secure)}=${value}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
}

/**
 * A marked request's Set-Cookie list with every NextAuth session cookie turned
 * into the embed cookie (a deletion stays a deletion). Everything else passes.
 */
export function rewriteSessionSetCookies(values: readonly string[], secure: boolean): string[] {
  return values.map((v) => {
    const eq = v.indexOf('=');
    const name = v.slice(0, eq).trim();
    if (!(SESSION_COOKIE_NAMES as readonly string[]).includes(name)) return v;
    const value = v.slice(eq + 1).split(';')[0];
    const deleting = /max-age=0\b/i.test(v) || /expires=thu, 01 jan 1970/i.test(v) || value === '';
    return embedSetCookie(deleting ? '' : value, secure, deleting ? 0 : EMBED_SESSION_MAX_AGE_S);
  });
}

/**
 * The Cookie header the server should see for a request carrying an embed
 * cookie and NO session cookie: the embed value under the session cookie's
 * name. null when nothing changes (feature off, a real session present, or no
 * embed cookie) — a real first-party session always wins.
 */
export function injectedCookieHeader(cookieHeader: string | null, secure: boolean, env: Env = process.env): string | null {
  if (!isEmbedSessionEnabled(env) || !cookieHeader) return null;
  const pairs = cookieHeader.split(/;\s*/).filter(Boolean);
  const get = (n: string) => pairs.find((p) => p.startsWith(`${n}=`))?.slice(n.length + 1);
  if (SESSION_COOKIE_NAMES.some((n) => get(n))) return null;
  const embed = get(embedCookieName(secure));
  if (!embed) return null;
  return [...pairs, `${sessionCookieName(secure)}=${embed}`].join('; ');
}
