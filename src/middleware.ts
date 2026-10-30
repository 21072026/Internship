import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { IS_DEMO_MODE, demoBlockReason } from '@/lib/demoMode';
import { REMEMBER_COOKIES, REMEMBER_HINT_COOKIE, clearRememberCookies } from '@/lib/rememberCookie';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/requestId';
import { hostnameOf, servedHosts } from '@/lib/servedHosts';
import { writeOriginVerdict } from '@/lib/writeOrigin';
import { bodyLimitVerdict } from '@/lib/bodyLimitRule';
import { LOCALE_HEADER, LOCALE_PATH_HEADER, isPrefixablePath, splitLocalePrefix } from '@/lib/localePath';
import type { Locale } from '@/i18n/config';
import { buildCsp } from '@/lib/cspPolicy.cjs';
import { readOnlyImpersonationBlocks } from '@/lib/impersonationPolicyRule';

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
    // An external document reviewer's link (#1859) — the same kind of token.
    pathname.startsWith('/api/document-review/') ||
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
    // The double opt-in's confirm / withdraw buttons (#2577): the signed token
    // is the credential, and a withdrawal must work from any browser — the
    // same argument as the unsubscribe routes above. Exact paths.
    pathname === '/api/contact-permission/confirm' ||
    pathname === '/api/contact-permission/opt-out' ||
    // Leaving a scheduled report (#1905) — same argument, exact path.
    pathname === '/api/report-subscriptions/unsubscribe' ||
    // Login-free survey answering (#1881): the invitation token is the
    // credential. Exact path.
    pathname === '/api/surveys/respond' ||
    // The one-click "how was the meeting?" links (#1896): the signed token is
    // the credential. A prefix with the trailing slash, so only token paths match.
    pathname.startsWith('/api/meeting-feedback/') ||
    // Public mentee application form.
    pathname === '/api/apply' ||
    // Public profile view counter.
    pathname === '/api/profile-view' ||
    // Inbound email bridge (authenticated by HMAC reply token + shared secret).
    pathname === '/api/inbound-email' ||
    // CSP violation reports (#1552): the browser sends them by itself, for an
    // unverified account's pages too. Exact path.
    pathname === '/api/csp-report'
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

/**
 * One correlation id per request (#1601).
 *
 * Minted here because middleware is the only code that runs on *every* matched
 * request, before anything can fail. It is forwarded to the route handler as a
 * request header (`NextResponse.next({ request: { headers } })`, read there by
 * `withRequestScope` in `src/lib/requestContext.ts`) and echoed on the response
 * by `middleware()` below — on the error responses too, since those are exactly
 * the requests somebody will ask about later.
 *
 * `crypto.randomUUID()` is available on the edge runtime; `node:crypto` is not
 * (see the SESSION_COOKIES note above for the same constraint). The mint and the
 * validation of an inbound value live in `@/lib/requestId`, which imports
 * nothing and is therefore edge-safe.
 */
/**
 * Where a page request goes, language-wise (#1386). `/tr/features` and
 * `/de/features` are REWRITTEN to `/features`, with the language and the
 * prefix-less path passed on as request headers: `getLocale()` reads the
 * language first (so a prefixed link always opens in its own language, cookie
 * or no cookie), and the root metadata builds the canonical and hreflang URLs
 * from the path. An unprefixed page request carries the path alone. A prefix on
 * a page that is not public (`/tr/admin`) is not rewritten — it 404s, because
 * only the public site has language URLs. The pure rules are in
 * src/lib/localePath.ts.
 */
type PageRouting = { locale: Locale | null; path: string; rewriteTo: string | null };

function pageRouting(pathname: string): PageRouting | null {
  if (pathname.startsWith('/api/')) return null;
  const { locale, rest } = splitLocalePrefix(pathname);
  if (locale && isPrefixablePath(rest)) return { locale, path: rest, rewriteTo: rest };
  return { locale: null, path: pathname, rewriteTo: null };
}

/**
 * The strict CSP, report-only, on every page request (#1552,
 * src/lib/cspPolicy.cjs). A fresh nonce per request goes into the policy and
 * into `x-nonce`; the policy rides on the REQUEST too, because that is where
 * Next.js reads the nonce to stamp its own <script> tags (it accepts the
 * report-only header for that). The browser enforces nothing from it — the
 * enforced policy is still next.config.js's — it only reports to
 * /api/csp-report what the strict one would block. `CSP_REPORT_ONLY=0` turns it
 * off. The analytics variables are named one by one: the edge bundle inlines a
 * NEXT_PUBLIC_* read only when it is spelled out.
 */
const CSP_NONCE_HEADER = 'x-nonce';
const REPORT_ONLY_HEADER = 'content-security-policy-report-only';

function reportOnlyPolicy(): { nonce: string; policy: string } | null {
  if (process.env.CSP_REPORT_ONLY === '0') return null;
  const nonce = btoa(crypto.randomUUID());
  const env = {
    NEXT_PUBLIC_PLAUSIBLE_DOMAIN: process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN,
    NEXT_PUBLIC_PLAUSIBLE_HOST: process.env.NEXT_PUBLIC_PLAUSIBLE_HOST,
    NEXT_PUBLIC_GA4_MEASUREMENT_ID: process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  };
  return { nonce, policy: buildCsp(env, { nonce, dev: process.env.NODE_ENV !== 'production' }) };
}

function nextWithRequestId(req: NextRequest, requestId: string, page: PageRouting | null = null): NextResponse {
  const headers = new Headers(req.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  // Never trusted from outside: only this function says which language a URL is in.
  headers.delete(LOCALE_HEADER);
  headers.delete(LOCALE_PATH_HEADER);
  // Nor which nonce a page carries: Next.js reads it from either CSP request
  // header, the enforced one first, so a client-sent one must not survive.
  headers.delete(CSP_NONCE_HEADER);
  headers.delete(REPORT_ONLY_HEADER);
  headers.delete('content-security-policy');
  let res: NextResponse;
  const csp = page ? reportOnlyPolicy() : null;
  if (csp) {
    headers.set(CSP_NONCE_HEADER, csp.nonce);
    headers.set(REPORT_ONLY_HEADER, csp.policy);
  }
  if (page) {
    headers.set(LOCALE_PATH_HEADER, page.path);
    if (page.locale) headers.set(LOCALE_HEADER, page.locale);
  }
  if (page?.rewriteTo) {
    const url = req.nextUrl.clone();
    url.pathname = page.rewriteTo;
    res = NextResponse.rewrite(url, { request: { headers } });
  } else {
    res = NextResponse.next({ request: { headers } });
  }
  if (csp) res.headers.set(REPORT_ONLY_HEADER, csp.policy);
  return res;
}

export async function middleware(req: NextRequest) {
  // An inbound id is honoured (a proxy or the k6 runner may already have one)
  // but never trusted verbatim into a log line — resolveRequestId bounds its
  // length and alphabet and mints a fresh id instead of repairing a bad one.
  const requestId = resolveRequestId(req.headers.get(REQUEST_ID_HEADER));
  const res = await handle(req, requestId);
  res.headers.set(REQUEST_ID_HEADER, requestId);
  return res;
}

async function handle(req: NextRequest, requestId: string): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const page = pageRouting(pathname);

  // English has no prefix (#1386), so `/en/features` is somebody's guess at
  // one: send it to the real URL rather than a 404. Public pages only, like
  // every other language rule here.
  const enPrefixed = /^\/en(\/.*)?$/.exec(pathname);
  if (enPrefixed && isPrefixablePath(enPrefixed[1] || '/')) {
    const url = req.nextUrl.clone();
    url.pathname = enPrefixed[1] || '/';
    return NextResponse.redirect(url, 308);
  }

  if (wantsResume(req, pathname)) {
    const url = req.nextUrl.clone();
    const next = `${pathname}${req.nextUrl.search}`;
    url.pathname = '/auth/resume';
    url.search = `?next=${encodeURIComponent(next)}`;
    return NextResponse.redirect(url);
  }

  // Cross-site write gate (#1467): a browser write to /api/* must come from one
  // of our own pages, and never as text/plain. The rule and its reasons are in
  // src/lib/writeOrigin.ts; it runs before every other write check so a forged
  // request learns nothing about the session it rode in on.
  if (pathname.startsWith('/api/')) {
    const verdict = writeOriginVerdict({
      method: req.method,
      pathname,
      origin: req.headers.get('origin'),
      secFetchSite: req.headers.get('sec-fetch-site'),
      contentType: req.headers.get('content-type'),
      requestHost: hostnameOf(req.headers.get('x-forwarded-host') ?? req.headers.get('host')),
      served: servedHosts(),
    });
    if (!verdict.ok) {
      return NextResponse.json(
        verdict.status === 415
          ? { error: 'Send JSON (Content-Type: application/json).', code: verdict.code }
          : { error: 'Cross-site requests cannot change data here.', code: verdict.code },
        { status: verdict.status }
      );
    }
  }

  // Request-body ceiling (#3210): a JSON write that declares a body larger than
  // the limit is refused before the handler buffers it. Rule, numbers and what
  // it cannot see (chunked bodies — that half is the proxy's) are in
  // src/lib/bodyLimitRule.ts.
  if (pathname.startsWith('/api/')) {
    const size = bodyLimitVerdict({
      method: req.method,
      pathname,
      contentType: req.headers.get('content-type'),
      contentLength: req.headers.get('content-length'),
      env: process.env,
    });
    if (!size.ok) {
      return NextResponse.json(
        { error: 'Request body too large.', code: 'payload_too_large', limit: size.limit },
        { status: 413 }
      );
    }
  }

  // Safety net for "remember me" (#1495): every sign-out control in the app
  // revokes the trusted device first (see lib/signOutClient.ts), but someone
  // can still POST NextAuth's own sign-out page directly — from a bookmark, or
  // the /api/auth/signout screen. Clearing the cookies here means a sign-out
  // never leaves a credential behind that would silently sign the browser back
  // in. Only the cookies: the edge runtime has no database, so the row is left
  // to expire (it is unreachable without the secret).
  if (req.method === 'POST' && pathname === '/api/auth/signout') {
    const res = nextWithRequestId(req, requestId, page);
    clearRememberCookies(res);
    return res;
  }

  // Read-only impersonation (#1586): ONE central refusal for every write the
  // impersonating session makes — the policy of the target's organization,
  // fixed in the JWT when the session started. Before the general allowlist on
  // purpose: a public form posted from someone else's session is still a write
  // made as them. Only the ways out pass (impersonationPolicyRule.ts). The
  // token is decoded for writes only; reads never pay for it.
  if (WRITE_METHODS.has(req.method) && readOnlyImpersonationBlocks(req.method, pathname)) {
    const imp = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
    if (imp?.impersonatorId && imp.impersonationReadOnly === true) {
      return NextResponse.json(
        { error: 'This is a read-only session as another user — changes are not allowed.', code: 'impersonation_read_only' },
        { status: 403, headers: { [REQUEST_ID_HEADER]: requestId } }
      );
    }
  }

  if (!WRITE_METHODS.has(req.method) || isAllowlisted(pathname)) {
    return nextWithRequestId(req, requestId, page);
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

  // WORLDS (#2590): nothing to add here, and that is deliberate. Which product a
  // session may be used in is decided by the `session` callback in src/lib/auth.ts
  // (a session presented on the other world's host is null), and it needs the
  // database — the org's CURRENT vertical — which the edge runtime does not have.
  // What this file reads from the JWT is a claim about the token's own account
  // (`emailVerified`), and every claim in a JWT belongs to exactly one user row,
  // so two accounts of one person can never blur into each other here. A token
  // presented on the wrong host passes this gate only to reach a handler whose
  // own `getServerSession()` returns null (401 / redirect to sign-in): this gate
  // narrows, it never grants. The remember-me cookies are host-only (no Domain),
  // so `wantsResume` above cannot carry a device from one world's host to the
  // other's either; /api/auth/remember/refresh re-checks the account's world.

  // Only block when we positively know the email is unverified. Anonymous
  // requests (token === null) are left to each route's own auth check, and
  // older sessions without the field (undefined) are treated as verified.
  if (token && token.emailVerified === false) {
    return NextResponse.json(
      { error: 'Please verify your email address to make changes.' },
      { status: 403 }
    );
  }

  return nextWithRequestId(req, requestId, page);
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
