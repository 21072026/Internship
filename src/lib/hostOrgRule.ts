// Host → tenant, the pure half (#1661). ZERO imports on purpose, so
// `node --test --experimental-strip-types` loads it with no resolve hook
// (scripts/test/host-org.test.mjs). The database half is src/lib/hostOrg.ts.
//
// TWO WAYS A HOST NAMES A TENANT, in this order:
//   1. The tenant's own domain: `Organization.publicHost`, EXACT match, and
//      only once `publicHostVerifiedAt` is set (DNS proof, #1662). An
//      unverified claim resolves to NOBODY — typing a hostname into a box
//      proves nothing, and a claimed-but-unproven domain must not pull a
//      competitor's pre-login traffic or SSO hand-off into the claimant's org.
//   2. `<slug>.<APP_ROOT_DOMAIN>` — exactly one label under the configured
//      root, and only while APP_ROOT_DOMAIN is set. Unset means no subdomain
//      tenancy at all, so the product's own hosts keep resolving to nobody.
//
// WHAT A RESOLVED HOST MAY DECIDE: branding, SSO discovery, pre-login copy —
// never data scope. A signed-in request's org comes from its session and only
// its session (src/lib/orgScope.ts resolveOrgId reads no header); the e2e spec
// e2e/host-org.spec.ts pins that a forged X-Forwarded-Host naming another
// tenant's verified domain changes nothing a signed-in admin reads. The Host
// header is attacker-controlled: it is only ever COMPARED with stored values
// here, never interpolated into a URL.

/** A slug as src/lib/orgSlug.ts makes it (≤ 60, single hyphens inside) — also a valid DNS label. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/**
 * A Host / X-Forwarded-Host value → bare lowercase hostname, or null. The
 * first entry of a proxy list, port and one trailing dot dropped; anything that
 * is not then a plain hostname (a wildcard, userinfo, a path) is refused.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.split(',')[0].trim().toLowerCase();
  host = host.replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return null;
  return host;
}

/** APP_ROOT_DOMAIN as configured, normalised; null when unset or malformed. */
export function normalizeRootDomain(raw: string | null | undefined): string | null {
  const root = normalizeHost(raw);
  // A root of one label ("com") would make every registrable domain a tenant.
  return root && root.includes('.') ? root : null;
}

/**
 * The tenant slug `host` names under `rootDomain`, or null. Exactly ONE label
 * below the root: `acme.example.com` → `acme`; `a.b.example.com`, the root
 * itself and `example.com.evil.test` → null.
 */
export function slugUnderRootDomain(host: string | null, rootDomain: string | null): string | null {
  if (!host || !rootDomain) return null;
  const suffix = `.${rootDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return SLUG_RE.test(label) ? label : null;
}
