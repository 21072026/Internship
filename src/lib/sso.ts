// Enterprise SSO configuration & gating (#545). The SAML round-trip IS live —
// `src/lib/ssoSaml.ts` builds the AuthnRequest and verifies the posted
// assertion; this module stores/validates a tenant's IdP config and exposes the
// guard (`isSsoActive`) that the login/ACS routes check before redirecting.
// OIDC is a roadmap item, not a shipped one: nothing builds an OIDC request, so
// it is refused at the write boundary here. See docs/sso-saml.md.
//
// Safe to import from the server; no client-only concerns.

import { orgPlanHasFeature, type OrgPlan } from '@/lib/orgPlans';

export type SsoProvider = 'saml' | 'oidc';

export interface SsoConfig {
  ssoEnabled: boolean;
  ssoProvider: string | null;
  ssoIssuer: string | null;
  ssoEntryPoint: string | null;
  ssoCertificate: string | null;
}

// Every provider the config *vocabulary* knows about…
export const SSO_PROVIDERS: SsoProvider[] = ['saml', 'oidc'];

// …and the subset the auth path can actually complete a login with. 'oidc' stays
// in the type/vocabulary (it is a real roadmap item), but a config naming it can
// neither be saved (validateSsoConfig) nor go live (isSsoActive) — the login
// route always builds a SAML request, so an OIDC tenant would be locked out.
export const SSO_IMPLEMENTED_PROVIDERS: SsoProvider[] = ['saml'];

export const SSO_OIDC_UNSUPPORTED = 'OIDC single sign-on is not supported yet — use SAML';

export function isSsoProvider(v: unknown): v is SsoProvider {
  return v === 'saml' || v === 'oidc';
}

export function isSsoProviderImplemented(v: unknown): v is SsoProvider {
  return isSsoProvider(v) && SSO_IMPLEMENTED_PROVIDERS.includes(v);
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

// The tenant's stored config plus the plan it is on — an Organization row
// satisfies this as-is, which is how every caller passes it.
export type SsoActivation = Partial<SsoConfig> & { plan?: OrgPlan | string | null };

// The guard the login/ACS path checks: SSO is only active for a tenant when it
// is switched on, completely configured, names a provider we can actually
// complete a login with AND the tenant's plan includes SSO_SAML. The provider
// check is what keeps an already-stored `oidc` row (written before that was
// refused) from producing a broken redirect — such a tenant falls back to
// password login instead of a dead end.
//
// Why the entitlement is checked HERE and not by deleting the config (#1742):
// SAML is a premium feature, so losing the entitlement has to stop IdP logins
// from being accepted — but a downgrade must not destroy the tenant's issuer,
// entry point and signing certificate. Wiping them would mean an upgrade back
// costs the customer's IT team another round-trip through their IdP, and a
// billing lapse would silently discard data we were trusted with. So the
// config survives untouched and only its *activation* is withdrawn: re-grant
// the plan and SSO resumes with nothing re-entered. The write boundary in
// PATCH /api/admin/organizations refuses to *change* the config meanwhile.
export function isSsoActive(c: SsoActivation | null | undefined): boolean {
  return !!c?.ssoEnabled && isSsoConfigComplete(c) && isSsoProviderImplemented(c.ssoProvider)
    && orgPlanHasFeature(c.plan, 'SSO_SAML');
}

// Validate an admin's incoming config before persisting. Returns an error
// message, or null when valid. Enabling requires a complete config. This is the
// single write boundary — every current and future write path inherits it.
export function validateSsoConfig(c: Partial<SsoConfig>): string | null {
  if (c.ssoProvider != null && c.ssoProvider !== '' && !isSsoProvider(c.ssoProvider)) {
    return 'SSO provider must be "saml" or "oidc"';
  }
  // Saving `oidc` used to return a green "saved" and lock every user of the
  // tenant out: the login route always builds a SAML request.
  if (isSsoProvider(c.ssoProvider) && !isSsoProviderImplemented(c.ssoProvider)) {
    return SSO_OIDC_UNSUPPORTED;
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
