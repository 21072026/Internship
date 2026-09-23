import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  hostnameOf,
  marketingHosts,
  configuredOrigin,
  servedHosts,
  isServedHost,
  requestOrigin,
  resolveRedirectTarget,
} from '../../src/lib/servedHosts.ts';

// The served-host allowlist and the redirect rule are a security boundary
// (#2488): a redirect NextAuth hands the browser, or a server-side Location,
// may go to a host this deployment serves and nowhere else. Pinned here where no
// browser is needed, like recoveryCodeFormat / lastContactRule.

const ENV = ['NEXTAUTH_URL', 'NEXT_PUBLIC_APP_URL', 'MARKETING_HOSTS'];
function setEnv(vars) {
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
beforeEach(() => setEnv({}));

test('hostnameOf: first entry of a proxy list, lowercased, port dropped', () => {
  assert.equal(hostnameOf(' Marketing.bcsit-gmbh.dev:443 , evil.example'), 'marketing.bcsit-gmbh.dev');
  assert.equal(hostnameOf('localhost:3000'), 'localhost');
  assert.equal(hostnameOf(''), null);
  assert.equal(hostnameOf(null), null);
  assert.equal(hostnameOf(':3000'), null);
});

test('marketingHosts: the single default when unset, the env list when set', () => {
  assert.deepEqual([...marketingHosts()], ['marketing.bcsit-gmbh.de']);
  setEnv({ MARKETING_HOSTS: ' marketing.bcsit-gmbh.dev:443, Other.Example ,' });
  assert.deepEqual([...marketingHosts()].sort(), ['marketing.bcsit-gmbh.dev', 'other.example']);
  assert.ok(!marketingHosts().has('marketing.bcsit-gmbh.de'), 'the default is replaced, not merged');
});

// The one assertion here that is not a literal moving with the code (#2540).
// Every other case asserts the host the default HAPPENS to be, so renaming the
// constant and the test together keeps them green whatever the value is. The
// marketing product moved off the ersah.in subdomains on 2026-09-23 and that
// apex now serves mail only: a default that lands back there would point the
// live marketing site at a name nobody operates, which is exactly the shape of
// a bad revert or a stale merge resolution.
test('marketingHosts: the default never falls back onto the retired ersah.in apex (#2540)', () => {
  for (const raw of [undefined, '', '   ']) {
    setEnv({ MARKETING_HOSTS: raw });
    for (const host of marketingHosts()) {
      assert.ok(!/(^|\.)ersah\.in$/.test(host), `default marketing host must not be on ersah.in: ${host}`);
    }
  }
});

test('marketingHosts: an EMPTY or whitespace-only MARKETING_HOSTS is "unset", not an empty list (#2428)', () => {
  // infra/deploy-prod.sh passes `-e MARKETING_HOSTS="${MARKETING_HOSTS:-}"`, so a
  // prod env file with no value yields '' in the container. Prod's marketing
  // domain served the internship landing for as long as '' counted as configured.
  for (const raw of ['', '   ', '\n']) {
    setEnv({ MARKETING_HOSTS: raw });
    assert.deepEqual([...marketingHosts()], ['marketing.bcsit-gmbh.de'], `raw=${JSON.stringify(raw)}`);
    assert.ok(isServedHost('marketing.bcsit-gmbh.de'), 'the default marketing host is a served host');
  }
  // A list of only separators is still "nothing configured" → default applies.
  setEnv({ MARKETING_HOSTS: ' , ' });
  assert.deepEqual([...marketingHosts()], []);
});

test('configuredOrigin: NEXTAUTH_URL first, then NEXT_PUBLIC_APP_URL, then the dev default — always a bare origin', () => {
  assert.equal(configuredOrigin(), 'http://localhost:3000');
  setEnv({ NEXT_PUBLIC_APP_URL: 'https://preview.interncrm.com/' });
  assert.equal(configuredOrigin(), 'https://preview.interncrm.com');
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com/some/path', NEXT_PUBLIC_APP_URL: 'https://other.example' });
  assert.equal(configuredOrigin(), 'https://interncrm.com');
  setEnv({ NEXTAUTH_URL: 'not a url' });
  assert.equal(configuredOrigin(), 'http://localhost:3000');
});

test('servedHosts per environment shape', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', NEXT_PUBLIC_APP_URL: 'https://interncrm.com' });
  assert.deepEqual([...servedHosts()].sort(), ['interncrm.com', 'marketing.bcsit-gmbh.de'], 'prod');
  setEnv({ NEXTAUTH_URL: 'https://preview.interncrm.com', NEXT_PUBLIC_APP_URL: 'https://preview.interncrm.com', MARKETING_HOSTS: 'marketing.bcsit-gmbh.dev' });
  assert.deepEqual([...servedHosts()].sort(), ['marketing.bcsit-gmbh.dev', 'preview.interncrm.com'], 'preview');
  // A topic env is covered by its OWN NEXTAUTH_URL — no wildcard, no per-PR list.
  setEnv({ NEXTAUTH_URL: 'https://pr123.interncrm.com', NEXT_PUBLIC_APP_URL: 'https://pr123.interncrm.com' });
  assert.deepEqual([...servedHosts()].sort(), ['marketing.bcsit-gmbh.de', 'pr123.interncrm.com'], 'topic');
  assert.ok(!servedHosts().has('pr124.interncrm.com'), 'a sibling topic host is NOT served');
  setEnv({});
  assert.deepEqual([...servedHosts()].sort(), ['localhost', 'marketing.bcsit-gmbh.de'], 'dev');
});

test('isServedHost: exact match on the header hostname, nothing else', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com' });
  assert.equal(isServedHost('interncrm.com'), true);
  assert.equal(isServedHost('INTERNCRM.COM:443'), true);
  assert.equal(isServedHost('marketing.bcsit-gmbh.de'), true);
  assert.equal(isServedHost('interncrm.com.evil.example'), false);
  assert.equal(isServedHost('evil.example'), false);
  assert.equal(isServedHost(''), false);
  assert.equal(isServedHost(undefined), false);
});

test('requestOrigin: the served request host wins; anything else is the configured origin', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com' });
  const H = (m) => (n) => m[n] ?? null;
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.bcsit-gmbh.de', 'x-forwarded-proto': 'https' })), 'https://marketing.bcsit-gmbh.de');
  assert.equal(requestOrigin(H({ host: 'marketing.bcsit-gmbh.de' })), 'https://marketing.bcsit-gmbh.de', 'Host alone works, protocol from config');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'evil.example' })), 'https://interncrm.com');
  assert.equal(requestOrigin(H({})), 'https://interncrm.com');
  // Never downgrade, never trust a received port.
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.bcsit-gmbh.de:99999', 'x-forwarded-proto': 'http' })), 'https://marketing.bcsit-gmbh.de');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.bcsit-gmbh.de, evil.example' })), 'https://marketing.bcsit-gmbh.de', 'first entry of a proxy list');
  // Dev: the configured port is re-attached for the configured host only.
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
  assert.equal(requestOrigin(H({ host: 'localhost:3000' })), 'http://localhost:3000');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.bcsit-gmbh.de' })), 'http://marketing.bcsit-gmbh.de');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.bcsit-gmbh.de', 'x-forwarded-proto': 'https' })), 'https://marketing.bcsit-gmbh.de', 'an http deployment may upgrade');
});

test('resolveRedirectTarget: NextAuth-default parity on the internship host', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com' });
  const B = 'https://interncrm.com';
  assert.equal(resolveRedirectTarget('/auth/signin', B), 'https://interncrm.com/auth/signin');
  assert.equal(resolveRedirectTarget('//evil.example', B), 'https://interncrm.com//evil.example', 'a path on our host, exactly as the default');
  assert.equal(resolveRedirectTarget('https://interncrm.com/x?y=1#z', B), 'https://interncrm.com/x?y=1#z', 'same origin is returned verbatim');
});

test('resolveRedirectTarget: a served host is kept, re-assembled; everything else is baseUrl', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com' });
  const B = 'https://interncrm.com';
  assert.equal(resolveRedirectTarget('https://marketing.bcsit-gmbh.de/auth/signin', B), 'https://marketing.bcsit-gmbh.de/auth/signin');
  assert.equal(resolveRedirectTarget('https://MARKETING.bcsit-gmbh.de/a?b=1#c', B), 'https://marketing.bcsit-gmbh.de/a?b=1#c');
  assert.equal(resolveRedirectTarget('https://marketing.bcsit-gmbh.de:8443/a', B), 'https://marketing.bcsit-gmbh.de/a', 'a received port is dropped');
  for (const bad of [
    'https://evil.example/',
    'https://interncrm.com.evil.example/',
    'https://interncrm.com@evil.example/',
    'https://marketing.bcsit-gmbh.de,evil.example/',
    'https://interncrm.com,x/',
    'http://marketing.bcsit-gmbh.de/',
    'javascript:alert(1)',
    'ftp://marketing.bcsit-gmbh.de/',
    'not a url',
    '',
  ]) assert.equal(resolveRedirectTarget(bad, B), B, `${JSON.stringify(bad)} must fall back to baseUrl`);
});

test('resolveRedirectTarget on a dev (http) base accepts the base protocol and https', () => {
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
  const B = 'http://localhost:3000';
  assert.equal(resolveRedirectTarget('http://localhost:3000/auth/signin', B), 'http://localhost:3000/auth/signin');
  assert.equal(resolveRedirectTarget('http://marketing.bcsit-gmbh.de/auth/signin', B), 'http://marketing.bcsit-gmbh.de/auth/signin');
  assert.equal(resolveRedirectTarget('https://marketing.bcsit-gmbh.de/auth/signin', B), 'https://marketing.bcsit-gmbh.de/auth/signin');
  assert.equal(resolveRedirectTarget('http://evil.example/', B), B);
});
