// One served-host allowlist (#2488, epic #2348) — ZERO imports on purpose, so it can be
// loaded by auth.ts, any route handler, the edge middleware if ever needed, and
// `node --test --experimental-strip-types` with no resolve hook.
//
// One container serves several public hosts behind a reverse proxy: the
// internship host and the marketing hosts (MARKETING_HOSTS) in prod, their
// preview twins on preview, and exactly its own pr<N> hosts in a topic env.
// Every redirect the app hands the browser, and every absolute same-app link it
// renders, must stay on the host the browser is on — and must NEVER be able to
// leave the set of hosts this deployment serves. That set is derived from
// config that already exists (NEXTAUTH_URL, NEXT_PUBLIC_APP_URL,
// MARKETING_HOSTS); there is no wildcard, no suffix rule and no new env var: a
// topic env is covered because its own host IS its NEXTAUTH_URL.
//
// Two consumers, one rule: hostVertical.ts (which host shows the marketing
// landing) and the redirect validation below read the same marketingHosts(), so
// "a host that gets the marketing copy" and "a host a redirect may stay on" can
// never drift apart.

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
 * There is NO built-in default: unset, EMPTY and whitespace-only all mean that
 * no host serves the marketing product, so every host is the internship one.
 * The deploy script threads the variable into the container as
 * `-e MARKETING_HOSTS="${MARKETING_HOSTS:-}"` (infra/deploy-prod.sh), so an env
 * file that never mentions it puts an EMPTY STRING here (#2428). Until #2926 an
 * empty value fell back to a production hostname written into this file; now
 * every environment names its own marketing hosts (the prod and preview env
 * files, infra/server/topic-deploy.sh for a topic env, playwright.config.ts for
 * the e2e server). One deployment's hostname is no longer everybody's default,
 * and an environment that forgets the variable shows the internship product on
 * every host rather than answering for a domain it does not own.
 */
export function marketingHosts(): Set<string> {
  const out = new Set<string>();
  for (const entry of (process.env.MARKETING_HOSTS ?? '').split(',')) {
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

// ── Verified tenant domains (#1661) ─────────────────────────────────────────
//
// A tenant may bring its own domain (`Organization.publicHost`), and once its
// ownership is proven by DNS (`publicHostVerifiedAt`, #1662) this deployment
// serves it too. That set lives in the DATABASE, and this file stays
// import-free (the edge middleware and the unit test load it), so it is never
// read here: callers that may honour a tenant domain fetch it with
// `verifiedTenantHosts()` (src/lib/hostOrg.ts) and pass it as `extraHosts` to
// requestOrigin / resolveRedirectTarget / servedOrigin. The rule does not
// change — EXACT hostname match, no wildcard, no suffix — and an unverified
// claim is never in the set. Every caller that passes nothing behaves exactly
// as before. A `<slug>.<APP_ROOT_DOMAIN>` host is deliberately NOT added: that
// would be a suffix rule.
export const NO_EXTRA_HOSTS: ReadonlySet<string> = new Set();

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
export function requestOrigin(
  get: (name: string) => string | null | undefined,
  extraHosts: ReadonlySet<string> = NO_EXTRA_HOSTS,
): string {
  const configured = configuredOrigin();
  const host = hostnameOf(get('x-forwarded-host') ?? get('host'));
  if (!host || !(servedHosts().has(host) || extraHosts.has(host))) return configured;
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
 *     `marketing.example.test,evil.example` all fall back to baseUrl;
 *   - the accepted url is re-assembled from its parts, which drops userinfo and
 *     any received port (prod hosts have none; a same-origin dev url is returned
 *     verbatim by the origin check above it).
 */
export function resolveRedirectTarget(url: string, baseUrl: string, extraHosts: ReadonlySet<string> = NO_EXTRA_HOSTS): string {
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
  const targetHost = target.hostname.toLowerCase();
  if (!servedHosts().has(targetHost) && !extraHosts.has(targetHost)) return baseUrl;
  return `${target.protocol}//${target.hostname}${target.pathname}${target.search}${target.hash}`;
}

// ── Links that cannot follow a request: e-mail (#2495) ──────────────────────
//
// `requestOrigin()` above answers "which host is the browser on". An e-mail has
// no browser yet: the invitation, the password reset and the verification mail
// are read later, somewhere else, and their link decides which PRODUCT the
// recipient lands in. Every one of them used to read NEXT_PUBLIC_APP_URL — the
// internship host — so a marketing admin's invitation said
// https://interncrm.com/auth/register?token=… and dropped the new sales rep
// into the other product.
//
// The recipient's tenant says where they belong, through the one explicit
// host mapping the schema has: `Organization.publicHost` (#2569, exact match,
// set by an operator, never inferred from a vertical). This is the pure half:
// given that column, the link origin is that host ONLY IF this deployment
// serves it (so a prod hostname copied into a topic env's database cannot send
// a topic-env mail to production), and otherwise exactly what it always was.
// Protocol follows the configured origin's (https everywhere but local dev); a
// port is re-attached only when the host is the configured one — same rules as
// requestOrigin().
//
// The DB half (the lookup by orgId) is src/lib/orgLinkOrigin.ts.
const LEGACY_LINK_ORIGIN = () => process.env.NEXT_PUBLIC_APP_URL || LOCAL_ORIGIN;

export function appLinkOrigin(publicHost: string | null | undefined): string {
  const legacy = LEGACY_LINK_ORIGIN();
  const host = hostnameOf(publicHost);
  if (!host || !servedHosts().has(host)) return legacy;
  let cfg: URL;
  try {
    cfg = new URL(legacy);
  } catch {
    return legacy;
  }
  if (cfg.hostname.toLowerCase() === host) return legacy;
  const proto = cfg.protocol === 'http:' ? 'http' : 'https';
  return `${proto}://${host}`;
}

// ── An origin that travelled through a third party: SSO / OAuth (#2494) ─────
//
// SAML's ACS and Google's OAuth callback are registered at the IdP / at Google
// under ONE host (NEXTAUTH_URL's), so the browser comes back there whichever
// host it left from. The originating origin rides along — as SAML RelayState,
// inside the signed OAuth `state` — and is read back here.
//
// RelayState in particular is signed by nobody: an IdP-initiated login, or
// anyone who can make a browser POST to the ACS, chooses it. So this is a
// redirect sink fed by remote input, and it gets resolveRedirectTarget()'s
// rule: the WHATWG parser, https or the configured origin's own protocol, a
// hostname in servedHosts() by EXACT match, and a value re-assembled from its
// parts. It must be a bare ORIGIN — a path, a query, a fragment or userinfo is
// refused rather than stripped, because nothing we mint carries one, so a value
// that does was not minted by us. The port follows requestOrigin(): only the
// configured origin's own port, and only on its own host.
//
// Returns null, never a fallback, so each caller decides what "no usable
// origin" means — for both flows today: the configured origin, as before.
export function servedOrigin(value: string | null | undefined, extraHosts: ReadonlySet<string> = NO_EXTRA_HOSTS): string | null {
  if (!value || typeof value !== 'string') return null;
  let target: URL;
  let cfg: URL;
  try {
    target = new URL(value);
    cfg = new URL(configuredOrigin());
  } catch {
    return null;
  }
  if (target.protocol !== 'https:' && target.protocol !== cfg.protocol) return null;
  if (target.username || target.password) return null;
  // 'https://a.example' and 'https://a.example/' both parse to pathname '/'.
  if (target.pathname !== '/' || target.search || target.hash) return null;
  const host = target.hostname.toLowerCase();
  if (!servedHosts().has(host) && !extraHosts.has(host)) return null;
  const sameHost = cfg.hostname.toLowerCase() === host;
  if (target.port && !(sameHost && target.port === cfg.port)) return null;
  const port = sameHost && cfg.port ? `:${cfg.port}` : '';
  return `${target.protocol}//${host}${port}`;
}
