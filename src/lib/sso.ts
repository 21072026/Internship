// Enterprise SSO configuration & gating (#545). Pure config plumbing — no SAML
// library and no live assertion handling yet (that needs the tenant's IdP
// metadata and a signed round-trip we can't exercise without a real IdP; see
// docs/sso-saml.md). This module stores/validates a tenant's SSO config and
// exposes the guard the (documented, not-yet-wired) auth code path will use, so
// enabling SSO later is a config + wiring step, not a schema change.
//
// Safe to import from the server; no client-only concerns.

export type SsoProvider = 'saml' | 'oidc';

export interface SsoConfig {
  ssoEnabled: boolean;
  ssoProvider: string | null;
  ssoIssuer: string | null;
  ssoEntryPoint: string | null;
  ssoCertificate: string | null;
}

export const SSO_PROVIDERS: SsoProvider[] = ['saml', 'oidc'];

export function isSsoProvider(v: unknown): v is SsoProvider {
  return v === 'saml' || v === 'oidc';
}

// A config is "complete" when every field the provider needs is present. This is
// independent of ssoEnabled — an admin can fill it in, validate, then flip the
// switch. SAML needs issuer + entry point + signing cert; OIDC needs issuer +
// entry point (discovery/authorization endpoint).
export function isSsoConfigComplete(c: Partial<SsoConfig> | null | undefined): boolean {
  if (!c) return false;
  const has = (s: string | null | undefined) => typeof s === 'string' && s.trim().length > 0;
  if (!isSsoProvider(c.ssoProvider)) return false;
  if (!has(c.ssoIssuer) || !has(c.ssoEntryPoint)) return false;
  if (c.ssoProvider === 'saml' && !has(c.ssoCertificate)) return false;
  return true;
}

// The guard the login/auth path checks: SSO is only active for a tenant when it
// is both switched on AND completely configured. Until per-tenant resolution +
// a SAML/OIDC library are wired (docs/sso-saml.md), no caller flips this to a
// live redirect — but the gate is the single source of truth when they do.
export function isSsoActive(c: Partial<SsoConfig> | null | undefined): boolean {
  return !!c?.ssoEnabled && isSsoConfigComplete(c);
}

// Validate an admin's incoming config before persisting. Returns an error
// message, or null when valid. Enabling requires a complete config.
export function validateSsoConfig(c: Partial<SsoConfig>): string | null {
  if (c.ssoProvider != null && c.ssoProvider !== '' && !isSsoProvider(c.ssoProvider)) {
    return 'SSO provider must be "saml" or "oidc"';
  }
  const url = (c.ssoEntryPoint ?? '').trim();
  if (url && !/^https:\/\//i.test(url)) {
    return 'SSO entry point must be an https URL';
  }
  if (c.ssoEnabled && !isSsoConfigComplete(c)) {
    return 'Cannot enable SSO until the provider, issuer, entry point (and certificate for SAML) are all set';
  }
  return null;
}
