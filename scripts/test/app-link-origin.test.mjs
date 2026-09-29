// Unit tests for the e-mail link origin (#2495).
// Run: node --test --experimental-strip-types scripts/test/app-link-origin.test.mjs
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { appLinkOrigin } from '../../src/lib/servedHosts.ts';

beforeEach(() => {
  process.env.NEXTAUTH_URL = 'https://interncrm.com';
  process.env.NEXT_PUBLIC_APP_URL = 'https://interncrm.com';
  process.env.MARKETING_HOSTS = '';
});

test('an org with no host mapping keeps the link every mail had before', () => {
  assert.equal(appLinkOrigin(null), 'https://interncrm.com');
  assert.equal(appLinkOrigin(undefined), 'https://interncrm.com');
  assert.equal(appLinkOrigin(''), 'https://interncrm.com');
});

test('a MARKETING org mapped to the marketing host gets links on that host', () => {
  // Prod configures no MARKETING_HOSTS; the default is the live marketing domain.
  assert.equal(appLinkOrigin('marketing.bcsit-gmbh.de'), 'https://marketing.bcsit-gmbh.de');
  assert.equal(appLinkOrigin('Marketing.BCSIT-GmbH.de'), 'https://marketing.bcsit-gmbh.de');
});

test('a mapping this deployment does not serve never leaves it', () => {
  // A prod hostname copied into a topic env's database, or a typo: the mail
  // must not send its reader to a host this container does not answer on.
  process.env.NEXTAUTH_URL = 'https://pr2495.interncrm.com';
  process.env.NEXT_PUBLIC_APP_URL = 'https://pr2495.interncrm.com';
  process.env.MARKETING_HOSTS = 'marketing.bcsit-gmbh.dev';
  assert.equal(appLinkOrigin('marketing.bcsit-gmbh.de'), 'https://pr2495.interncrm.com');
  assert.equal(appLinkOrigin('evil.example'), 'https://pr2495.interncrm.com');
  assert.equal(appLinkOrigin('marketing.bcsit-gmbh.dev'), 'https://marketing.bcsit-gmbh.dev');
});

test('the configured host itself is returned verbatim, port included', () => {
  process.env.NEXTAUTH_URL = 'http://localhost:3000';
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  assert.equal(appLinkOrigin('localhost'), 'http://localhost:3000');
  // Local dev is http, so a mapped host stays http — and never inherits :3000.
  assert.equal(appLinkOrigin('marketing.bcsit-gmbh.de'), 'http://marketing.bcsit-gmbh.de');
});
