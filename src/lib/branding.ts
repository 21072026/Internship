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
