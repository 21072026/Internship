// One served-host allowlist (#2488, epic #2348) — ZERO imports on purpose, so it can be
// loaded by auth.ts, any route handler, the edge middleware if ever needed, and
// `node --test --experimental-strip-types` with no resolve hook.
//
// One container serves several public hosts behind Caddy: interncrm.com and
// marketing.ersah.in in prod, preview.interncrm.com and preview-marketing.ersah.in
// on preview, exactly its own pr<N>.interncrm.com in a topic env. Every redirect
// the app hands the browser, and every absolute same-app link it renders, must
// stay on the host the browser is on — and must NEVER be able to leave the set
// of hosts this deployment serves. That set is derived from config that already
// exists (NEXTAUTH_URL, NEXT_PUBLIC_APP_URL, MARKETING_HOSTS); there is no
// wildcard, no suffix rule and no new env var: a topic env is covered because
// its own host IS its NEXTAUTH_URL.
//
// Two consumers, one rule: hostVertical.ts (which host shows the marketing
// landing) and the redirect validation below read the same marketingHosts(), so
// "a host that gets the marketing copy" and "a host a redirect may stay on" can
// never drift apart.

const DEFAULT_MARKETING_HOST = 'marketing.ersah.in';
const LOCAL_ORIGIN = 'http://localhost:3000';

/**
 * Normalise a Host / X-Forwarded-Host HEADER value to a bare lowercase hostname.
 * X-Forwarded-Host may carry a comma list (proxy chain) — the first entry is the
 * client's — and a port, which is dropped. For a URL's hostname use
 * `new URL(...).hostname` and compare directly; this helper is for headers only.
 */
export function hostnameOf(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const first = hostHeader.split(',')[0].trim().toLowerCase();
  return first.replace(/:\d+$/, '') || null;
}

/**
 * The hosts that serve the MARKETING landing (MARKETING_HOSTS, comma-separated).
 *
 * Unset, EMPTY and whitespace-only all mean the default (#2428). The deploy
 * script threads the variable into the container as
 * `-e MARKETING_HOSTS="${MARKETING_HOSTS:-}"` (infra/deploy-prod.sh), so an env
 * file that never mentions it — prod's, by design, because .env.example says the
 * default covers the live domain — puts an EMPTY STRING here, not an absent
 * variable. `??` took that as a configured empty list, the set came out empty,
 * and marketing.ersah.in served the internship landing (and, once #2488 shared
 * this set with the redirect allowlist, was not a served host either). The
 * trim() is what keeps prod, which configures nothing, on the default.
 */
export function marketingHosts(): Set<string> {
  const configured = process.env.MARKETING_HOSTS;
  const raw = configured && configured.trim() ? configured : DEFAULT_MARKETING_HOST;
  const out = new Set<string>();
  for (const entry of raw.split(',')) {
    const h = hostnameOf(entry);
    if (h) out.add(h);
  }
  return out;
}

/**
 * The configured origin — NEXTAUTH_URL, else NEXT_PUBLIC_APP_URL, else the dev
 * default — normalised to a bare origin (no path, no trailing slash). This is
 * what NextAuth uses as its baseUrl and what every link falls back to when the
 * request host is not one we serve.
 */
export function configuredOrigin(): string {
  const raw = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_APP_URL || LOCAL_ORIGIN;
  try {
    return new URL(raw).origin;
  } catch {
    return LOCAL_ORIGIN;
  }
}

/** Every hostname this deployment serves. Exact-match set; nothing else. */
export function servedHosts(): Set<string> {
  const out = marketingHosts();
  out.add(new URL(configuredOrigin()).hostname.toLowerCase());
  const secondary = process.env.NEXT_PUBLIC_APP_URL;
  if (secondary) {
    try {
      out.add(new URL(secondary).hostname.toLowerCase());
    } catch {
      // A malformed NEXT_PUBLIC_APP_URL adds nothing rather than something wrong.
    }
  }
  return out;
}

/** Is this Host / X-Forwarded-Host header value one of the hosts we serve? */
export function isServedHost(hostHeader: string | null | undefined): boolean {
  const h = hostnameOf(hostHeader);
  return h !== null && servedHosts().has(h);
}

/**
 * The origin the BROWSER is on, for a server-side redirect or an absolute
 * same-app link: read from the proxy's X-Forwarded-Host / Host, accepted only
 * if that host is one we serve, else the configured origin. Protocol never
 * downgrades (an https deployment answers https whatever the header says) and a
 * received port is never trusted — only the configured origin's own port (the
 * dev server's :3000) is re-attached, and only for that host.
 */
export function requestOrigin(get: (name: string) => string | null | undefined): string {
  const configured = configuredOrigin();
  const host = hostnameOf(get('x-forwarded-host') ?? get('host'));
  if (!host || !servedHosts().has(host)) return configured;
  const cfg = new URL(configured);
  const forwardedProto = (get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase();
  const proto = cfg.protocol === 'https:' || forwardedProto === 'https' ? 'https' : 'http';
  const port = cfg.hostname === host && cfg.port ? `:${cfg.port}` : '';
  return `${proto}://${host}${port}`;
}

/**
 * The body of NextAuth's `callbacks.redirect` (#2488). NextAuth normalises every
 * callbackUrl it hands back to the browser with baseUrl = origin(NEXTAUTH_URL)
 * and never sees the request, so its default keeps an absolute url only when
 * its origin IS baseUrl — which is why a relative '/auth/signin' from the
 * marketing host landed on the internship host. Here:
 *   - a relative url resolves against baseUrl exactly as NextAuth's default does
 *     (so `//evil.example` is still a path on our host, as today);
 *   - an absolute url is parsed with the WHATWG URL parser (never string-prefix
 *     checked — see safeRedirect.ts for why), must be https or baseUrl's own
 *     protocol, and its `hostname` must be in servedHosts() by EXACT match, so
 *     `interncrm.com.evil.example`, `https://interncrm.com@evil.example` and
 *     `marketing.ersah.in,evil.example` all fall back to baseUrl;
 *   - the accepted url is re-assembled from its parts, which drops userinfo and
 *     any received port (prod hosts have none; a same-origin dev url is returned
 *     verbatim by the origin check above it).
 */
export function resolveRedirectTarget(url: string, baseUrl: string): string {
  if (url.startsWith('/')) return `${baseUrl}${url}`;
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (target.protocol !== 'https:' && target.protocol !== base.protocol) return baseUrl;
  if (target.origin === base.origin) return url;
  if (!servedHosts().has(target.hostname.toLowerCase())) return baseUrl;
  return `${target.protocol}//${target.hostname}${target.pathname}${target.search}${target.hash}`;
}
