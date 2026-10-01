// Unit tests for the cross-site write gate (#1467).
// Run: node --test --experimental-strip-types scripts/test/write-origin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOriginExempt, mimeOf, writeOriginVerdict } from '../../src/lib/writeOrigin.ts';

const served = new Set(['interncrm.com', 'marketing.bcsit-gmbh.de']);
const req = (over = {}) => ({
  method: 'POST',
  pathname: '/api/admin/api-keys',
  origin: null,
  secFetchSite: null,
  contentType: 'application/json',
  requestHost: 'interncrm.com',
  served,
  ...over,
});
const verdict = (over) => writeOriginVerdict(req(over));
const CROSS = { ok: false, status: 403, code: 'cross_site_write' };
const MEDIA = { ok: false, status: 415, code: 'unsupported_media_type' };

test('our own pages pass: same-origin, or an Origin we serve', () => {
  assert.deepEqual(verdict({ secFetchSite: 'same-origin', origin: 'https://interncrm.com' }), { ok: true });
  // One container, several hosts: a page on the marketing host is ours too.
  assert.deepEqual(verdict({ secFetchSite: 'same-site', origin: 'https://marketing.bcsit-gmbh.de' }), { ok: true });
  // No Sec-Fetch-* (an old Safari): the Origin decides.
  assert.deepEqual(verdict({ origin: 'https://interncrm.com' }), { ok: true });
  // The request's own host counts even if it is missing from the list.
  assert.deepEqual(verdict({ origin: 'http://localhost:3000', requestHost: 'localhost' }), { ok: true });
});

test('the #1467 attack: a sibling host on the same site is refused', () => {
  // A topic env or any other *.interncrm.com page is same-SITE — Lax sends the cookie.
  assert.deepEqual(verdict({ secFetchSite: 'same-site', origin: 'https://pr999.interncrm.com' }), CROSS);
  assert.deepEqual(verdict({ secFetchSite: 'cross-site', origin: 'https://evil.example' }), CROSS);
  assert.deepEqual(verdict({ origin: 'https://evil.example' }), CROSS);
  // A lookalike is not an exact match.
  assert.deepEqual(verdict({ origin: 'https://interncrm.com.evil.example' }), CROSS);
});

test('an opaque or missing Origin never passes a same-site/cross-site write', () => {
  assert.deepEqual(verdict({ secFetchSite: 'cross-site', origin: null }), CROSS);
  assert.deepEqual(verdict({ secFetchSite: 'same-site', origin: 'null' }), CROSS);
  assert.deepEqual(verdict({ origin: 'null' }), CROSS);
  assert.deepEqual(verdict({ origin: 'file:///tmp/x.html' }), CROSS);
});

test('no browser headers at all = not a browser, passes as before (webhooks, cron, SCIM, Gmail)', () => {
  assert.deepEqual(verdict({}), { ok: true });
  assert.deepEqual(verdict({ secFetchSite: 'none' }), { ok: true });
});

test('text/plain bodies are refused even from our own origin (the enctype trick)', () => {
  assert.deepEqual(verdict({ secFetchSite: 'same-origin', contentType: 'text/plain' }), MEDIA);
  assert.deepEqual(verdict({ contentType: 'Text/Plain; charset=UTF-8' }), MEDIA);
  // The other CORS-simple types are not JSON-parseable; uploads use multipart.
  assert.deepEqual(verdict({ contentType: 'multipart/form-data; boundary=x' }), { ok: true });
  assert.deepEqual(verdict({ contentType: 'application/x-www-form-urlencoded' }), { ok: true });
  assert.deepEqual(verdict({ contentType: null }), { ok: true });
  // The origin refusal wins over the media one: a forged request learns nothing more.
  assert.deepEqual(verdict({ secFetchSite: 'cross-site', origin: 'https://evil.example', contentType: 'text/plain' }), CROSS);
});

test('reads, and anything outside /api/, are none of its business', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.deepEqual(verdict({ method, secFetchSite: 'cross-site', origin: 'https://evil.example' }), { ok: true });
  }
  assert.deepEqual(verdict({ pathname: '/admin', secFetchSite: 'cross-site', origin: 'https://evil.example' }), { ok: true });
  assert.deepEqual(verdict({ method: 'delete', secFetchSite: 'cross-site', origin: 'https://evil.example' }), CROSS);
});

test('the exempt list is exactly the cookie-less endpoints', () => {
  assert.equal(isOriginExempt('/api/auth/sso/acme/acs'), true);
  assert.equal(isOriginExempt('/api/auth/sso/acme/acs/'), true);
  assert.equal(isOriginExempt('/api/inbound-email'), true);
  assert.equal(isOriginExempt('/api/webhooks/jaas'), true);
  assert.equal(isOriginExempt('/api/cron/start'), true);
  for (const p of ['/api/auth/sso/acme/login', '/api/auth/sso/a/b/acs', '/api/inbound-email/poll', '/api/webhooks', '/api/cron', '/api/admin/api-keys']) {
    assert.equal(isOriginExempt(p), false, p);
  }
  // An IdP page auto-submitting the SAML response is cross-site by nature.
  assert.deepEqual(
    verdict({ pathname: '/api/auth/sso/acme/acs', secFetchSite: 'cross-site', origin: 'https://idp.example', contentType: 'application/x-www-form-urlencoded' }),
    { ok: true },
  );
});

test('mimeOf strips parameters and case', () => {
  assert.equal(mimeOf('Application/JSON; charset=utf-8'), 'application/json');
  assert.equal(mimeOf(''), null);
  assert.equal(mimeOf(null), null);
});
