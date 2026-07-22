import { test, expect } from '@playwright/test';
import { mapSamlProfile, spEntityId, acsUrl } from '../src/lib/ssoSaml';

// Deterministic coverage for the pure SAML profile→identity mapping (#545). The
// signed-assertion verification itself is delegated to @node-saml/node-saml
// (upstream-tested); the live IdP round-trip is verified on preview. Here we lock
// down the claim-alias handling we own.

test('maps plain email/name attributes', () => {
  expect(mapSamlProfile({ email: 'Alice@Acme.com', name: 'Alice Doe' })).toEqual({
    email: 'alice@acme.com',
    fullName: 'Alice Doe',
  });
});

test('falls back to NameID for email and first+last for name', () => {
  expect(mapSamlProfile({ nameID: 'BOB@acme.com', firstName: 'Bob', lastName: 'Roe' })).toEqual({
    email: 'bob@acme.com',
    fullName: 'Bob Roe',
  });
});

test('handles Okta/AD WS-* claim URIs', () => {
  const profile = {
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'carol@acme.com',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'Carol',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname': 'Fox',
  };
  expect(mapSamlProfile(profile)).toEqual({ email: 'carol@acme.com', fullName: 'Carol Fox' });
});

test('email-only assertion yields a null name (not a crash)', () => {
  expect(mapSamlProfile({ email: 'dan@acme.com' })).toEqual({ email: 'dan@acme.com', fullName: null });
});

test('throws when the assertion carries no email', () => {
  expect(() => mapSamlProfile({ name: 'No Email' })).toThrow(/no email/i);
  expect(() => mapSamlProfile(null)).toThrow(/Empty SAML profile/i);
});

test('SP identifiers are per-tenant and derive from the app base URL', () => {
  // Whatever NEXTAUTH_URL is in this env, the shapes must be slug-scoped + consistent.
  expect(acsUrl('sso-test')).toMatch(/\/api\/auth\/sso\/sso-test\/acs$/);
  expect(spEntityId('sso-test')).toMatch(/\/sso\/sso-test$/);
});
