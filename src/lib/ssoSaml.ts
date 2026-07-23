// SAML round-trip wiring for Enterprise SSO (#545). Server-only (node-saml uses
// node crypto + XML) — only imported by the SSO route handlers and the `sso`
// NextAuth provider, never a client bundle.
//
// This turns a tenant's stored IdP config (Organization.sso*) into a working
// SP-initiated SAML login: build the AuthnRequest (login route), and verify the
// signed assertion posted back (ACS route). Identity → user mapping is handled by
// provisionSsoUser (src/lib/ssoProvisioning.ts).

import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';

function appBase(): string {
  return (
    process.env.NEXTAUTH_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

// The SP identifiers a tenant registers in its IdP. Per-org so one IdP can host
// several of our tenants without audience collisions.
export function spEntityId(slug: string): string {
  return `${appBase()}/sso/${slug}`;
}
export function acsUrl(slug: string): string {
  return `${appBase()}/api/auth/sso/${slug}/acs`;
}

export interface OrgSamlConfig {
  ssoEntryPoint: string | null;
  ssoIssuer: string | null;
  ssoCertificate: string | null;
}

// Build a node-saml instance for a tenant. Assumes the config is complete
// (callers gate on isSsoActive first).
export function samlForOrg(slug: string, cfg: OrgSamlConfig): SAML {
  return new SAML({
    callbackUrl: acsUrl(slug),
    entryPoint: cfg.ssoEntryPoint ?? '',
    issuer: spEntityId(slug),
    idpCert: cfg.ssoCertificate ?? '',
    audience: spEntityId(slug),
    // Most IdPs (incl. mocksaml, Okta default) sign the assertion, not always the
    // whole response — require the assertion signature, which is what protects
    // the identity claims.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 5000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    // We run stateless (serverless) with no shared AuthnRequest-id cache, so we
    // don't validate InResponseTo — this also allows IdP-initiated login. The
    // assertion signature + audience/recipient checks remain the security anchor.
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
