// SAML round-trip wiring for Enterprise SSO (#545). Server-only (node-saml uses
// node crypto + XML) — only imported by the SSO route handlers and the `sso`
// NextAuth provider, never a client bundle.
//
// This turns a tenant's stored IdP config (Organization.sso*) into a working
// SP-initiated SAML login: build the AuthnRequest (login route), and verify the
// signed assertion posted back (ACS route). Identity → user mapping is handled by
// provisionSsoUser (src/lib/ssoProvisioning.ts).

import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml';
import { idpCertificates } from '@/lib/ssoCertificates';

function appBase(): string {
  return (
    process.env.NEXTAUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

const trimBase = (base: string) => base.replace(/\/+$/, '');

// The SP identifiers a tenant registers in its IdP. Per-org so one IdP can host
// several of our tenants without audience collisions.
//
// `base` (#1661): a tenant on its own verified domain registers ITS host's
// identifiers, so each builder takes an explicit origin. It defaults to
// NEXTAUTH_URL's, so every IdP registration that exists today stays valid; a
// caller passes a base only from a verified host (src/lib/hostOrg.ts), never
// from a raw Host header.
export function spEntityId(slug: string, base: string = appBase()): string {
  return `${trimBase(base)}/sso/${slug}`;
}
export function acsUrl(slug: string, base: string = appBase()): string {
  return `${trimBase(base)}/api/auth/sso/${slug}/acs`;
}
// The document a customer's identity team imports in one click (#1931), instead
// of hand-copying the two identifiers above out of our docs.
export function metadataUrl(slug: string, base: string = appBase()): string {
  return `${trimBase(base)}/api/auth/sso/${slug}/metadata`;
}

// Our Single Logout endpoint (#1952): where the IdP sends a LogoutRequest, and
// the LogoutResponse to one we started. Published in the metadata below.
export function sloUrl(slug: string, base: string = appBase()): string {
  return `${trimBase(base)}/api/auth/sso/${slug}/slo`;
}

// The slug reaches spMetadataXml straight from the URL, so every interpolated
// value goes through this — an unescaped `"` would let a crafted slug close an
// attribute and inject markup into a document IdPs parse.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// SAML 2.0 SP metadata for one tenant. Pure + string-returning, so it is
// verifiable without an IdP. The two claims it makes must stay in lockstep with
// samlForOrg below — the NameID format and wantAssertionsSigned are the same
// settings node-saml enforces on the assertion, so an IdP that trusts this
// document sends exactly what we accept.
//
// Element order is fixed by the metadata schema (SSODescriptorType's children
// come before SPSSODescriptor's own): NameIDFormat must precede
// AssertionConsumerService, or a strict validator rejects the document.
//
// Single Logout (#1952) adds two things, in the schema's order (KeyDescriptor,
// then SingleLogoutService, both before NameIDFormat): our certificate and the
// SLO endpoint in both bindings we accept. Since #1955 the same certificate is
// published twice — `use="signing"` (our LogoutRequest/Response and, when the
// tenant switched it on, our AuthnRequest) and `use="encryption"` (what an IdP
// encrypts assertions to). AuthnRequestsSigned follows the tenant's switch.
export function spMetadataXml(
  slug: string,
  signingCertificatePem?: string | null,
  opts: { authnRequestsSigned?: boolean } = {},
): string {
  const entityId = escapeXml(spEntityId(slug));
  const acs = escapeXml(acsUrl(slug));
  const slo = escapeXml(sloUrl(slug));
  const certBody = (signingCertificatePem ?? '').replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const keyInfo = `<ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${escapeXml(certBody)}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>`;
  const keyDescriptor = certBody
    ? `
    <md:KeyDescriptor use="signing">
      ${keyInfo}
    </md:KeyDescriptor>
    <md:KeyDescriptor use="encryption">
      ${keyInfo}
    </md:KeyDescriptor>`
    : '';
  const signed = opts.authnRequestsSigned ? 'true' : 'false';
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="${signed}" WantAssertionsSigned="true">${keyDescriptor}
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${slo}"/>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${slo}"/>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acs}" index="0" isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>
`;
}

export interface OrgSamlConfig {
  ssoEntryPoint: string | null;
  ssoIssuer: string | null;
  ssoCertificate: string | null;
}

export { idpCertificates } from '@/lib/ssoCertificates';

const idpCertOption = (stored: string | null | undefined): string | string[] => {
  const certs = idpCertificates(stored);
  return certs.length > 1 ? certs : (certs[0] ?? '');
};

/** What the sign-in exchange may use beyond the stored IdP config (#1955). */
export interface SamlLoginOptions {
  /** Our SP private key: decrypts encrypted assertions; signs AuthnRequests when `signRequests`. */
  spPrivateKeyPem?: string | null;
  signRequests?: boolean;
  /** The request store (SamlRequestStore); without one nothing is correlated. */
  requestStore?: CacheProvider | null;
  /** `always` instead of `ifPresent` — refuses IdP-initiated sign-in. */
  requireInResponseTo?: boolean;
}

// Build a node-saml instance for a tenant. Assumes the config is complete
// (callers gate on isSsoActive first). With no options this is exactly the
// pre-#1955 instance — unsigned requests, no decryption, no correlation — which
// is what "Test connection" still uses; the login and ACS routes build theirs
// through samlLoginForOrg() (src/lib/ssoSamlLogin.ts).
export function samlForOrg(slug: string, cfg: OrgSamlConfig, opts: SamlLoginOptions = {}): SAML {
  const key = opts.spPrivateKeyPem || undefined;
  return new SAML({
    callbackUrl: acsUrl(slug),
    entryPoint: cfg.ssoEntryPoint ?? '',
    issuer: spEntityId(slug),
    idpCert: idpCertOption(cfg.ssoCertificate),
    audience: spEntityId(slug),
    // Most IdPs (incl. mocksaml, Okta default) sign the assertion, not always the
    // whole response — require the assertion signature, which is what protects
    // the identity claims. It stays the anchor whatever else is switched on.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 5000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    // Signed AuthnRequests (#1955): only when the tenant switched them on — an
    // IdP that does not yet trust our certificate refuses a signed request.
    ...(key && opts.signRequests ? { privateKey: key, signatureAlgorithm: 'sha256' as const } : {}),
    // Encrypted assertions: receive-side only, safe whenever the key exists.
    ...(key ? { decryptionPvk: key } : {}),
    // InResponseTo (#1955): with a request store, a response that names a
    // request must name a live, unused one of ours (`ifPresent`, so IdP-
    // initiated sign-in still works); `always` is the tenant's opt-in. Without
    // a store — "Test connection" — nothing is correlated, as before.
    ...(opts.requestStore
      ? {
          cacheProvider: opts.requestStore,
          validateInResponseTo: opts.requireInResponseTo ? ValidateInResponseTo.always : ValidateInResponseTo.ifPresent,
          requestIdExpirationPeriodMs: 10 * 60 * 1000,
        }
      : { validateInResponseTo: ValidateInResponseTo.never }),
  });
}

export interface OrgSamlLogoutConfig extends OrgSamlConfig {
  ssoLogoutUrl: string | null;
}

// The node-saml instance for Single Logout (#1952) — separate from samlForOrg
// on purpose: it carries OUR private key, and node-saml signs every message an
// instance with a key sends, the AuthnRequest included. The sign-in path stays
// exactly what it was; only logout messages are signed. `logoutUrl` is the
// IdP's SingleLogoutService, where both our LogoutRequest and our
// LogoutResponse go (HTTP-Redirect binding).
export function samlLogoutForOrg(slug: string, cfg: OrgSamlLogoutConfig, privateKeyPem: string): SAML {
  return new SAML({
    callbackUrl: acsUrl(slug),
    entryPoint: cfg.ssoEntryPoint ?? '',
    logoutUrl: cfg.ssoLogoutUrl ?? undefined,
    logoutCallbackUrl: sloUrl(slug),
    issuer: spEntityId(slug),
    idpCert: idpCertOption(cfg.ssoCertificate),
    audience: spEntityId(slug),
    privateKey: privateKeyPem,
    signatureAlgorithm: 'sha256',
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: 5000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    validateInResponseTo: ValidateInResponseTo.never,
  });
}

export interface SamlIdentity {
  email: string;
  fullName: string | null;
}

// Map a verified node-saml profile to our identity shape. Handles the common
// email/name claim aliases (plain attribute names + the WS-* claim URIs Okta/AD
// emit), falling back to the NameID for the email. Pure + deterministic — unit
// tested without any IdP.
export function mapSamlProfile(profile: Record<string, unknown> | null | undefined): SamlIdentity {
  if (!profile) throw new Error('Empty SAML profile');
  const str = (k: string): string | null => {
    const v = profile[k];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const email = (
    str('email') ||
    str('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress') ||
    str('nameID')
  )?.toLowerCase();
  if (!email) throw new Error('SAML assertion carries no email');

  const first =
    str('firstName') || str('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname');
  const last =
    str('lastName') || str('http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname');
  const fullName =
    str('name') ||
    str('displayName') ||
    [first, last].filter(Boolean).join(' ').trim() ||
    null;

  return { email, fullName: fullName || null };
}
