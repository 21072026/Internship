// Social sign-in (#1962) — the pure rules: which providers exist, how each
// spells "verified", and THE linking rule. No Next, no DB.
//
// Run: npm run test:unit  (node --test --experimental-strip-types)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { configuredProviders, socialIdentityFrom, decideSocialSignIn, canUnlinkIdentity, microsoftIssuerMatches } = await import(
  '../../src/lib/socialProvidersRule.ts'
);

test('a provider is offered only with the flag on and both credentials present', () => {
  const env = { SOCIAL_GOOGLE_CLIENT_ID: 'g', SOCIAL_GOOGLE_CLIENT_SECRET: 's', SOCIAL_LINKEDIN_CLIENT_ID: 'l' };
  assert.deepEqual(configuredProviders(env), [], 'flag off → nothing');
  const on = configuredProviders({ ...env, SOCIAL_SIGN_IN: '1' });
  assert.deepEqual(on.map((p) => p.id), ['google'], 'LinkedIn has no secret → invisible');
  assert.equal(on[0].issuer, 'https://accounts.google.com');
  const ms = configuredProviders({ SOCIAL_SIGN_IN: '1', SOCIAL_MICROSOFT_CLIENT_ID: 'm', SOCIAL_MICROSOFT_CLIENT_SECRET: 's' })[0];
  assert.equal(ms.perDirectoryIssuer, true);
  const pinned = configuredProviders({ SOCIAL_SIGN_IN: '1', SOCIAL_MICROSOFT_CLIENT_ID: 'm', SOCIAL_MICROSOFT_CLIENT_SECRET: 's', SOCIAL_MICROSOFT_ISSUER: 'https://idp.example/x' })[0];
  assert.equal(pinned.perDirectoryIssuer, false, 'an explicit issuer is a fixed one');
});

test('Microsoft: the issuer must be the directory the token names', () => {
  const tid = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  assert.equal(microsoftIssuerMatches(`https://login.microsoftonline.com/${tid}/v2.0`, { tid }), true);
  assert.equal(microsoftIssuerMatches(`https://login.microsoftonline.com/${tid}/v2.0`, { tid: '00000000-0000-0000-0000-000000000000' }), false);
  assert.equal(microsoftIssuerMatches('https://evil.example/v2.0', { tid }), false);
});

test('a missing or false verification claim is UNVERIFIED; Microsoft speaks xms_edov', () => {
  assert.equal(socialIdentityFrom('google', { sub: 's', email: 'A@x.test', email_verified: true }).emailVerified, true);
  assert.equal(socialIdentityFrom('google', { sub: 's', email: 'a@x.test' }).emailVerified, false);
  assert.equal(socialIdentityFrom('google', { sub: 's', email: 'a@x.test', email_verified: false }).emailVerified, false);
  assert.equal(socialIdentityFrom('linkedin', { sub: 's', email: 'a@x.test', email_verified: 'true' }).emailVerified, true);
  assert.equal(socialIdentityFrom('microsoft', { sub: 's', email: 'a@x.test' }).emailVerified, false);
  assert.equal(socialIdentityFrom('microsoft', { sub: 's', email: 'a@x.test', xms_edov: true }).emailVerified, true);
  assert.equal(socialIdentityFrom('google', { sub: 's', email: 'A@X.TEST', email_verified: true }).email, 'a@x.test');
  assert.equal(socialIdentityFrom('google', { email: 'a@x.test' }), null, 'no subject, no identity');
});

const id = (over = {}) => ({ subject: 's', email: 'a@x.test', emailVerified: true, name: 'A', ...over });
const decide = (over = {}) => decideSocialSignIn({ identityUserId: null, linkUserId: null, matchedUserId: null, identity: id(), selfRegistration: 'auto', ...over });

test('a known subject always lands on the same account — linked on the SUBJECT, not the email', () => {
  assert.deepEqual(decide({ identityUserId: 'u1', matchedUserId: 'u2', identity: id({ email: 'changed@x.test' }) }), { action: 'sign_in', userId: 'u1' });
  assert.deepEqual(decide({ identityUserId: 'u1', identity: id({ emailVerified: false }) }), { action: 'sign_in', userId: 'u1' });
});

test('an UNVERIFIED email never links and never creates', () => {
  assert.deepEqual(decide({ matchedUserId: 'u2', identity: id({ emailVerified: false }) }), { action: 'refuse', reason: 'unverified_email' });
  assert.deepEqual(decide({ identity: id({ emailVerified: false }) }), { action: 'refuse', reason: 'unverified_email' });
  assert.deepEqual(decide({ identity: id({ email: null, emailVerified: false }) }), { action: 'refuse', reason: 'no_email' });
});

test('a verified match links; no match creates, parked under manual self-registration', () => {
  assert.deepEqual(decide({ matchedUserId: 'u2' }), { action: 'link_and_sign_in', userId: 'u2' });
  assert.deepEqual(decide(), { action: 'create', pending: false });
  assert.deepEqual(decide({ selfRegistration: 'manual' }), { action: 'create', pending: true });
});

test('connect from settings links to the signed-in account; a subject owned by someone else is refused', () => {
  assert.deepEqual(decide({ linkUserId: 'me', identity: id({ emailVerified: false }) }), { action: 'link_only', userId: 'me' });
  assert.deepEqual(decide({ linkUserId: 'me', identityUserId: 'other' }), { action: 'refuse', reason: 'identity_taken' });
  assert.deepEqual(decide({ linkUserId: 'me', identityUserId: 'me' }), { action: 'link_only', userId: 'me' });
});

test('the last way in stays', () => {
  assert.equal(canUnlinkIdentity(false, 1), false);
  assert.equal(canUnlinkIdentity(false, 2), true);
  assert.equal(canUnlinkIdentity(true, 1), true);
});
