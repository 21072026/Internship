// Provider-specific SSO completeness (#1926): what each provider needs before a
// tenant may switch SSO on. SAML is unchanged; an OIDC config needs a client ID,
// a (sealed) client secret and a discovery URL, so a half-filled one can never
// be enabled. Browserless — pure functions only.
import { test, expect } from '@playwright/test';
import { isSsoConfigComplete, missingSsoFields, validateSsoConfig } from '../src/lib/sso';

const saml = {
  ssoProvider: 'saml',
  ssoIssuer: 'https://idp.example.test/saml',
  ssoEntryPoint: 'https://idp.example.test/sso',
  ssoCertificate: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
};
const oidc = {
  ssoProvider: 'oidc',
  ssoIssuer: 'https://login.example.test',
  ssoClientId: 'client-123',
  ssoClientSecretEnc: 'sealed:v1:abc',
  ssoDiscoveryUrl: 'https://login.example.test/.well-known/openid-configuration',
};

test('the per-provider completeness matrix', { tag: '@smoke' }, () => {
  expect(isSsoConfigComplete(saml)).toBe(true);
  for (const field of ['ssoIssuer', 'ssoEntryPoint', 'ssoCertificate'] as const) {
    expect(isSsoConfigComplete({ ...saml, [field]: '' }), `SAML without ${field}`).toBe(false);
  }
  // SAML never needed the OIDC fields, and still does not.
  expect(isSsoConfigComplete({ ...saml, ssoClientId: null, ssoClientSecretEnc: null })).toBe(true);

  expect(isSsoConfigComplete(oidc)).toBe(true);
  for (const field of ['ssoIssuer', 'ssoClientId', 'ssoClientSecretEnc', 'ssoDiscoveryUrl'] as const) {
    expect(isSsoConfigComplete({ ...oidc, [field]: '  ' }), `OIDC without ${field}`).toBe(false);
  }
  // The old rule called issuer + entry point a complete OIDC config.
  expect(isSsoConfigComplete({ ssoProvider: 'oidc', ssoIssuer: oidc.ssoIssuer, ssoEntryPoint: 'https://login.example.test/authorize' })).toBe(false);
  expect(isSsoConfigComplete({ ...oidc, ssoProvider: 'ldap' })).toBe(false);
  expect(isSsoConfigComplete(null)).toBe(false);
});

test('a refusal names exactly what is missing', { tag: '@smoke' }, () => {
  expect(missingSsoFields({ ...oidc, ssoClientId: null, ssoClientSecretEnc: '' })).toEqual(['client ID', 'client secret']);
  expect(missingSsoFields({ ...saml, ssoCertificate: null })).toEqual(['certificate']);
  expect(missingSsoFields({ ssoProvider: null })).toEqual(['provider']);
});

test('the discovery URL must be https', { tag: '@smoke' }, () => {
  expect(validateSsoConfig({ ...saml, ssoDiscoveryUrl: 'http://login.example.test/.well-known/openid-configuration' }))
    .toBe('OIDC discovery URL must be an https URL');
});

test('a SAML tenant cannot be enabled half-configured, and a complete one can', { tag: '@smoke' }, () => {
  expect(validateSsoConfig({ ...saml, ssoEnabled: true, ssoCertificate: null })).toMatch(/missing: certificate/);
  expect(validateSsoConfig({ ...saml, ssoEnabled: true })).toBeNull();
});

import { mapOidcClaims } from '../src/lib/ssoOidcClaims';

test('OIDC claims: email required and verified when the IdP says, name from name or given + family (#1929)', { tag: '@smoke' }, () => {
  expect(mapOidcClaims({ email: ' A@Example.TEST ', name: 'Ada Lovelace', email_verified: true })).toEqual({ email: 'a@example.test', fullName: 'Ada Lovelace' });
  expect(mapOidcClaims({ email: 'b@example.test', given_name: 'Grace', family_name: 'Hopper' })).toEqual({ email: 'b@example.test', fullName: 'Grace Hopper' });
  expect(mapOidcClaims({ email: 'c@example.test' })).toEqual({ email: 'c@example.test', fullName: null });
  expect(() => mapOidcClaims({ email: 'd@example.test', email_verified: false })).toThrow(/not verified/);
  expect(() => mapOidcClaims({ email: 'd@example.test', email_verified: 'false' })).toThrow(/not verified/);
  expect(() => mapOidcClaims({ name: 'No Mail' })).toThrow(/no email/);
  expect(() => mapOidcClaims(null)).toThrow();
});
