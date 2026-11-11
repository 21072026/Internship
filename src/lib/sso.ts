// Enterprise SSO configuration & gating (#545). Both protocols are live: SAML
// (`src/lib/ssoSaml.ts`, docs/sso-saml.md) and, since #1929, OpenID Connect
// (`src/lib/ssoOidc.ts`, docs/sso-oidc.md). This module stores/validates a
// tenant's IdP config and exposes the guard (`isSsoActive`) the login, ACS and
// callback routes check before doing anything.
//
// Safe to import from the server; no client-only concerns.

import { orgPlanHasFeature, type OrgPlan } from '@/lib/orgPlans';
import { certificateInfo } from '@/lib/ssoMetadata';
import { idpCertificates } from '@/lib/ssoCertificates';

export type SsoProvider = 'saml' | 'oidc';

// secretBox purpose of the sealed OIDC client secret (#1926). Its own label,
// so the key that seals it seals nothing else.
export const OIDC_CLIENT_SECRET_PURPOSE = 'sso-oidc-client-secret';

export interface SsoConfig {
  ssoEnabled: boolean;
  ssoProvider: string | null;
  ssoIssuer: string | null;
  ssoEntryPoint: string | null;
  ssoCertificate: string | null;
  // The IdP's SingleLogoutService (#1952). Optional: SSO works without SLO.
  ssoLogoutUrl?: string | null;
  // OpenID Connect (#1926). The secret is judged only for presence here — it
  // is stored sealed, and this module never opens it.
  ssoClientId?: string | null;
  ssoClientSecretEnc?: string | null;
  ssoDiscoveryUrl?: string | null;
}

// Every provider the config *vocabulary* knows about…
export const SSO_PROVIDERS: SsoProvider[] = ['saml', 'oidc'];

// …and the subset the auth path can complete a login with. A provider is added
// here only together with its login route branch; until #1929 'oidc' was refused
// at the write boundary because the login route always built a SAML request.
export const SSO_IMPLEMENTED_PROVIDERS: SsoProvider[] = ['saml', 'oidc'];

export function isSsoProvider(v: unknown): v is SsoProvider {
  return v === 'saml' || v === 'oidc';
}

export function isSsoProviderImplemented(v: unknown): v is SsoProvider {
  return isSsoProvider(v) && SSO_IMPLEMENTED_PROVIDERS.includes(v);
}

// A config is "complete" when every field the provider needs is present. This is
// independent of ssoEnabled — an admin can fill it in, validate, then flip the
// switch. Per provider (#1926):
//   SAML — issuer + entry point + signing certificate (unchanged);
//   OIDC — issuer + client ID + client secret + discovery URL. The discovery
//          document names the authorization, token and JWKS endpoints, so an
//          OIDC config has no entry point of its own. (An explicit endpoint
//          triple instead of discovery is deliberately not offered: Entra ID,
//          Google Workspace and Okta all publish discovery.)
const has = (s: string | null | undefined) => typeof s === 'string' && s.trim().length > 0;

export function isSsoConfigComplete(c: Partial<SsoConfig> | null | undefined): boolean {
  if (!c) return false;
  if (!isSsoProvider(c.ssoProvider)) return false;
  if (!has(c.ssoIssuer)) return false;
  if (c.ssoProvider === 'saml') return has(c.ssoEntryPoint) && has(c.ssoCertificate);
  return has(c.ssoClientId) && has(c.ssoClientSecretEnc) && has(c.ssoDiscoveryUrl);
}

/** What an incomplete config still lacks, for the refusal message. */
export function missingSsoFields(c: Partial<SsoConfig>): string[] {
  const out: string[] = [];
  if (!isSsoProvider(c.ssoProvider)) return ['provider'];
  if (!has(c.ssoIssuer)) out.push('issuer');
  if (c.ssoProvider === 'saml') {
    if (!has(c.ssoEntryPoint)) out.push('entry point');
    if (!has(c.ssoCertificate)) out.push('certificate');
  } else {
    if (!has(c.ssoClientId)) out.push('client ID');
    if (!has(c.ssoClientSecretEnc)) out.push('client secret');
    if (!has(c.ssoDiscoveryUrl)) out.push('discovery URL');
  }
  return out;
}

// The tenant's stored config plus the plan it is on — an Organization row
// satisfies this as-is, which is how every caller passes it.
//
// `plan` is REQUIRED, not optional, and that is load-bearing: isSsoActive is
// fail-closed on a missing plan, so an optional field would let the natural
// optimisation of a login/ACS route — narrowing the query to `select` just the
// SAML columns — compile green and silently take every SSO tenant in the
// product offline. Required makes that a type error at the call site instead.
export type SsoActivation = Partial<SsoConfig> & { plan: OrgPlan | string | null };

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

// A SAML signing certificate that does not parse, or has already expired, would
// save cleanly and then fail at the first real assertion — in front of the
// whole tenant (#1933). Refused at save time instead, naming the problem.
//
// Several PEM blocks are several trusted certificates (#1955, a key rotation:
// the IdP's current and next one). Each is judged on its own, and the message
// names which one fails — an expired one has to be removed, not kept "just in
// case", because it would still be trusted.
export function validateSsoCertificate(pem: string, now: Date = new Date()): string | null {
  const certs = idpCertificates(pem);
  for (const [i, cert] of certs.entries()) {
    const which = certs.length > 1 ? ` #${i + 1}` : '';
    const info = certificateInfo(cert);
    if (!info) return `SSO certificate${which} could not be parsed — paste the IdP\'s X.509 signing certificate (PEM)`;
    if (info.notAfter.getTime() <= now.getTime()) {
      return `SSO certificate${which} expired on ${info.notAfter.toISOString().slice(0, 10)} — ask the IdP for its current signing certificate`;
    }
  }
  return null;
}

// Validate an admin's incoming config before persisting. Returns an error
// message, or null when valid. Enabling requires a complete config. This is the
// single write boundary — every current and future write path inherits it.
//
// `checkCertificate` is set by the caller when the request writes a new
// certificate or switches SSO on: only then is the stored certificate judged.
// Switching SSO off, enforcing it or clearing the config must keep working for
// a tenant whose certificate has already lapsed — that is how they get out.
export function validateSsoConfig(
  c: Partial<SsoConfig>,
  opts: { checkCertificate?: boolean; now?: Date } = {},
): string | null {
  if (c.ssoProvider != null && c.ssoProvider !== '' && !isSsoProvider(c.ssoProvider)) {
    return 'SSO provider must be "saml" or "oidc"';
  }
  // A provider in the vocabulary that no login route can complete would save
  // green and lock every user of the tenant out.
  if (isSsoProvider(c.ssoProvider) && !isSsoProviderImplemented(c.ssoProvider)) {
    return `SSO provider "${c.ssoProvider}" is not supported`;
  }
  const url = (c.ssoEntryPoint ?? '').trim();
  if (url && !/^https:\/\//i.test(url)) {
    return 'SSO entry point must be an https URL';
  }
  const slo = (c.ssoLogoutUrl ?? '').trim();
  if (slo && !/^https:\/\//i.test(slo)) {
    return 'SSO logout URL must be an https URL';
  }
  const discovery = (c.ssoDiscoveryUrl ?? '').trim();
  if (discovery && !/^https:\/\//i.test(discovery)) {
    return 'OIDC discovery URL must be an https URL';
  }
  if (c.ssoEnabled && !isSsoConfigComplete(c)) {
    return `Cannot enable SSO until the configuration is complete — missing: ${missingSsoFields(c).join(', ')}`;
  }
  if (opts.checkCertificate && c.ssoProvider === 'saml' && c.ssoCertificate?.trim()) {
    return validateSsoCertificate(c.ssoCertificate, opts.now);
  }
  return null;
}
