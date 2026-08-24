// White-label branding resolution (#546). Pure data + helpers, no DB imports,
// so it is safe to import from client components as well as the server.
//
// A tenant (Organization) may override the product's name, logo, accent color
// and support email. When a field is null/blank the app falls back to its own
// defaults below. This module only *resolves* branding; applying it to the live
// chrome per request depends on tenant resolution (the #543 enforcement slice),
// so in this phase branding is managed and resolvable but not yet applied to the
// single-tenant UI.

export interface Branding {
  brandName: string | null;
  brandLogoUrl: string | null;
  brandColor: string | null;
  supportEmail: string | null;
}

export interface ResolvedBranding {
  name: string;
  logoUrl: string | null;
  color: string | null;
  supportEmail: string | null;
}

// Product defaults used when a tenant hasn't set an override.
export const DEFAULT_BRANDING: ResolvedBranding = {
  name: 'Internship CRM',
  logoUrl: null,
  color: null,
  supportEmail: null,
};

function clean(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

// Merge a tenant's (possibly partial/null) branding over the product defaults.
export function resolveBranding(b: Partial<Branding> | null | undefined): ResolvedBranding {
  return {
    name: clean(b?.brandName) ?? DEFAULT_BRANDING.name,
    logoUrl: clean(b?.brandLogoUrl) ?? DEFAULT_BRANDING.logoUrl,
    color: clean(b?.brandColor) ?? DEFAULT_BRANDING.color,
    supportEmail: clean(b?.supportEmail) ?? DEFAULT_BRANDING.supportEmail,
  };
}

// A hex color like #1a2b3c or #abc (validated before persisting a brand color).
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export function isHexColor(v: string): boolean {
  return HEX_RE.test(v.trim());
}

/**
 * Whether a tenant-supplied brand logo URL is safe to persist.
 *
 * `brandLogoUrl` was only length-checked, and it is consumed in two places that
 * both trust it: the certificate renderer FETCHES it from the server
 * (src/lib/certificatePdf.ts — an SSRF surface, hence the https-only rule and
 * the resolved-address check that runs there on top of this) and every
 * transactional email interpolates it into an `<img src>`. Validating it once at
 * the write boundary is what keeps both honest, and it gives the admin an error
 * on the form instead of a logo that silently never renders.
 *
 * Allowed: an `https://` URL without embedded credentials, a same-origin
 * absolute path, or an inline `data:image/…`. Everything else — `http://`
 * (plaintext, and the scheme every internal-network target speaks),
 * `javascript:`, and protocol-relative `//host/x` (which inherits https but
 * points at a foreign host) — is refused.
 */
export function isSafeBrandLogoUrl(v: string): boolean {
  const t = v.trim();
  if (!t) return true; // blank clears the field
  if (t.startsWith('//')) return false; // protocol-relative: a foreign host in disguise
  if (t.startsWith('/')) return true; // same-origin path
  if (/^data:image\/(?:png|jpeg|jpg|gif|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(t)) return true;
  try {
    const url = new URL(t);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
