// Cross-site write gate for /api/* (#1467) — ZERO imports on purpose, so the
// edge middleware can run it and `node --test --experimental-strip-types` can
// test it (scripts/test/write-origin.test.mjs) with no resolve hook.
//
// WHY
//   The session cookie is `SameSite=Lax`, and SameSite is scoped at eTLD+1: a
//   page on ANY host of the same registrable domain (every pr<N>.interncrm.com
//   topic env is one) is same-SITE with production, so Lax attaches the cookie
//   to its POST. A JSON fetch from there still preflights and dies — but the
//   handlers call `request.json()`, which parses a `text/plain` body just as
//   happily, and an HTML form with `enctype="text/plain"` is a CORS-simple
//   request: no preflight, cookie attached, `{"name":"pwned","pad":"=…"}` is
//   valid JSON. One click minted an admin API key.
//
// THE RULE (belt and braces, each half enough on its own)
//   1. A write a BROWSER sends must come from one of our own pages.
//      `Sec-Fetch-Site: same-origin` (or `none`, a user-typed request) passes.
//      `same-site` / `cross-site` pass only with an `Origin` whose host is one
//      this deployment serves. Without Sec-Fetch-* (an old Safari) the `Origin`
//      is judged the same way; `Origin: null` (a sandboxed frame, a privacy
//      redirect) never passes. A request with NEITHER header is not a browser
//      — a webhook, the cron, SCIM, Gmail's one-click unsubscribe — and it
//      carries no victim cookie, so it passes exactly as before.
//   2. A write whose body is `text/plain` is refused with 415. No client in
//      src/ sends one (a fetch with a string body and no header would; there
//      is none), and it is the only CORS-simple type `request.json()` can
//      parse — so the form trick above stays dead even if rule 1 is relaxed.
//
// EXEMPT — endpoints that never authenticate by cookie, so there is nothing
// to forge: the SAML ACS (the one legitimate browser-driven cross-site POST,
// auto-submitted by an IdP page, authenticated by a signed assertion), and the
// three machine endpoints authenticated by a shared secret — the inbound-mail
// bridge, the JaaS webhook and the cron starter — whose senders are not ours
// to hold to a content type. Adding a path here needs the same reason.

export const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SAML_ACS = /^\/api\/auth\/sso\/[^/]+\/acs\/?$/;

const SECRET_AUTHENTICATED = new Set(['/api/inbound-email', '/api/webhooks/jaas', '/api/cron/start']);

export function isOriginExempt(pathname: string): boolean {
  return SAML_ACS.test(pathname) || SECRET_AUTHENTICATED.has(pathname.replace(/\/$/, ''));
}

export interface WriteRequest {
  method: string;
  pathname: string;
  origin: string | null;
  secFetchSite: string | null;
  contentType: string | null;
  /** Hostname the request was addressed to (Host / X-Forwarded-Host), no port. */
  requestHost: string | null;
  /** Every hostname this deployment serves (servedHosts()). */
  served: ReadonlySet<string>;
}

export type WriteVerdict =
  | { ok: true }
  | { ok: false; status: 403; code: 'cross_site_write' }
  | { ok: false; status: 415; code: 'unsupported_media_type' };

const OK: WriteVerdict = { ok: true };

function originHost(origin: string): string | null {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isOurs(origin: string | null, req: WriteRequest): boolean {
  if (!origin || origin === 'null') return false;
  const host = originHost(origin);
  if (!host) return false;
  return req.served.has(host) || (!!req.requestHost && host === req.requestHost.toLowerCase());
}

/** Mime type without parameters, lower-cased: `Text/Plain; charset=UTF-8` → `text/plain`. */
export function mimeOf(contentType: string | null): string | null {
  if (!contentType) return null;
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return mime || null;
}

export function writeOriginVerdict(req: WriteRequest): WriteVerdict {
  if (!WRITE_METHODS.has(req.method.toUpperCase())) return OK;
  if (!req.pathname.startsWith('/api/') || isOriginExempt(req.pathname)) return OK;

  const site = req.secFetchSite?.trim().toLowerCase() || null;
  if (site) {
    if (site !== 'same-origin' && site !== 'none' && !isOurs(req.origin, req)) {
      return { ok: false, status: 403, code: 'cross_site_write' };
    }
  } else if (req.origin !== null && !isOurs(req.origin, req)) {
    return { ok: false, status: 403, code: 'cross_site_write' };
  }

  if (mimeOf(req.contentType) === 'text/plain') {
    return { ok: false, status: 415, code: 'unsupported_media_type' };
  }
  return OK;
}
