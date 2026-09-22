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
  assert.equal(hostnameOf(' Preview-Marketing.ersah.in:443 , evil.example'), 'preview-marketing.ersah.in');
  assert.equal(hostnameOf('localhost:3000'), 'localhost');
  assert.equal(hostnameOf(''), null);
  assert.equal(hostnameOf(null), null);
  assert.equal(hostnameOf(':3000'), null);
});

test('marketingHosts: the single default when unset, the env list when set', () => {
  assert.deepEqual([...marketingHosts()], ['marketing.ersah.in']);
  setEnv({ MARKETING_HOSTS: ' preview-marketing.ersah.in:443, Other.Example ,' });
  assert.deepEqual([...marketingHosts()].sort(), ['other.example', 'preview-marketing.ersah.in']);
  assert.ok(!marketingHosts().has('marketing.ersah.in'), 'the default is replaced, not merged');
});

test('marketingHosts: an EMPTY or whitespace-only MARKETING_HOSTS is "unset", not an empty list (#2428)', () => {
  // infra/deploy-prod.sh passes `-e MARKETING_HOSTS="${MARKETING_HOSTS:-}"`, so a
  // prod env file with no value yields '' in the container. Prod's marketing
  // domain served the internship landing for as long as '' counted as configured.
  for (const raw of ['', '   ', '\n']) {
    setEnv({ MARKETING_HOSTS: raw });
    assert.deepEqual([...marketingHosts()], ['marketing.ersah.in'], `raw=${JSON.stringify(raw)}`);
    assert.ok(isServedHost('marketing.ersah.in'), 'the default marketing host is a served host');
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
  assert.deepEqual([...servedHosts()].sort(), ['interncrm.com', 'marketing.ersah.in'], 'prod');
  setEnv({ NEXTAUTH_URL: 'https://preview.interncrm.com', NEXT_PUBLIC_APP_URL: 'https://preview.interncrm.com', MARKETING_HOSTS: 'preview-marketing.ersah.in' });
  assert.deepEqual([...servedHosts()].sort(), ['preview-marketing.ersah.in', 'preview.interncrm.com'], 'preview');
  // A topic env is covered by its OWN NEXTAUTH_URL — no wildcard, no per-PR list.
  setEnv({ NEXTAUTH_URL: 'https://pr123.interncrm.com', NEXT_PUBLIC_APP_URL: 'https://pr123.interncrm.com' });
  assert.deepEqual([...servedHosts()].sort(), ['marketing.ersah.in', 'pr123.interncrm.com'], 'topic');
  assert.ok(!servedHosts().has('pr124.interncrm.com'), 'a sibling topic host is NOT served');
  setEnv({});
  assert.deepEqual([...servedHosts()].sort(), ['localhost', 'marketing.ersah.in'], 'dev');
});

test('isServedHost: exact match on the header hostname, nothing else', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com' });
  assert.equal(isServedHost('interncrm.com'), true);
  assert.equal(isServedHost('INTERNCRM.COM:443'), true);
  assert.equal(isServedHost('marketing.ersah.in'), true);
  assert.equal(isServedHost('interncrm.com.evil.example'), false);
  assert.equal(isServedHost('evil.example'), false);
  assert.equal(isServedHost(''), false);
  assert.equal(isServedHost(undefined), false);
});

test('requestOrigin: the served request host wins; anything else is the configured origin', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com' });
  const H = (m) => (n) => m[n] ?? null;
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.ersah.in', 'x-forwarded-proto': 'https' })), 'https://marketing.ersah.in');
  assert.equal(requestOrigin(H({ host: 'marketing.ersah.in' })), 'https://marketing.ersah.in', 'Host alone works, protocol from config');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'evil.example' })), 'https://interncrm.com');
  assert.equal(requestOrigin(H({})), 'https://interncrm.com');
  // Never downgrade, never trust a received port.
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.ersah.in:99999', 'x-forwarded-proto': 'http' })), 'https://marketing.ersah.in');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.ersah.in, evil.example' })), 'https://marketing.ersah.in', 'first entry of a proxy list');
  // Dev: the configured port is re-attached for the configured host only.
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
  assert.equal(requestOrigin(H({ host: 'localhost:3000' })), 'http://localhost:3000');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.ersah.in' })), 'http://marketing.ersah.in');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.ersah.in', 'x-forwarded-proto': 'https' })), 'https://marketing.ersah.in', 'an http deployment may upgrade');
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
  assert.equal(resolveRedirectTarget('https://marketing.ersah.in/auth/signin', B), 'https://marketing.ersah.in/auth/signin');
  assert.equal(resolveRedirectTarget('https://MARKETING.ersah.in/a?b=1#c', B), 'https://marketing.ersah.in/a?b=1#c');
  assert.equal(resolveRedirectTarget('https://marketing.ersah.in:8443/a', B), 'https://marketing.ersah.in/a', 'a received port is dropped');
  for (const bad of [
    'https://evil.example/',
    'https://interncrm.com.evil.example/',
    'https://interncrm.com@evil.example/',
    'https://marketing.ersah.in,evil.example/',
    'https://interncrm.com,x/',
    'http://marketing.ersah.in/',
    'javascript:alert(1)',
    'ftp://marketing.ersah.in/',
    'not a url',
    '',
  ]) assert.equal(resolveRedirectTarget(bad, B), B, `${JSON.stringify(bad)} must fall back to baseUrl`);
});

test('resolveRedirectTarget on a dev (http) base accepts the base protocol and https', () => {
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000' });
  const B = 'http://localhost:3000';
  assert.equal(resolveRedirectTarget('http://localhost:3000/auth/signin', B), 'http://localhost:3000/auth/signin');
  assert.equal(resolveRedirectTarget('http://marketing.ersah.in/auth/signin', B), 'http://marketing.ersah.in/auth/signin');
  assert.equal(resolveRedirectTarget('https://marketing.ersah.in/auth/signin', B), 'https://marketing.ersah.in/auth/signin');
  assert.equal(resolveRedirectTarget('http://evil.example/', B), B);
});
