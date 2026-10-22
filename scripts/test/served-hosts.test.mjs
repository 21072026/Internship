import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  hostnameOf,
  marketingHosts,
  configuredOrigin,
  servedHosts,
  isServedHost,
  requestOrigin,
  resolveRedirectTarget,
  servedOrigin,
} from '../../src/lib/servedHosts.ts';

// The served-host allowlist and the redirect rule are a security boundary
// (#2488): a redirect NextAuth hands the browser, or a server-side Location,
// may go to a host this deployment serves and nowhere else. Pinned here where no
// browser is needed, like recoveryCodeFormat / lastContactRule.
//
// Every hostname below is a reserved example name (RFC 2606): the marketing
// hosts are whatever MARKETING_HOSTS says, and there is no built-in one (#2926).
const MKT = 'marketing.example.test';
const MKT_PREVIEW = 'marketing.preview.example.test';

const ENV = ['NEXTAUTH_URL', 'NEXT_PUBLIC_APP_URL', 'MARKETING_HOSTS'];
function setEnv(vars) {
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}
beforeEach(() => setEnv({}));

test('hostnameOf: first entry of a proxy list, lowercased, port dropped', () => {
  assert.equal(hostnameOf(' Marketing.Preview.Example.Test:443 , evil.example'), 'marketing.preview.example.test');
  assert.equal(hostnameOf('localhost:3000'), 'localhost');
  assert.equal(hostnameOf(''), null);
  assert.equal(hostnameOf(null), null);
  assert.equal(hostnameOf(':3000'), null);
});

test('marketingHosts: nothing when unset, exactly the env list when set (#2926)', () => {
  assert.deepEqual([...marketingHosts()], []);
  setEnv({ MARKETING_HOSTS: ` ${MKT_PREVIEW}:443, Other.Example ,` });
  assert.deepEqual([...marketingHosts()].sort(), [MKT_PREVIEW, 'other.example']);
  setEnv({ MARKETING_HOSTS: `${MKT},${MKT_PREVIEW}` });
  assert.deepEqual([...marketingHosts()], [MKT, MKT_PREVIEW], 'in the order given — the first is the primary');
});

test('marketingHosts: an EMPTY, whitespace-only or separator-only MARKETING_HOSTS is no marketing host at all (#2428, #2926)', () => {
  // infra/deploy-prod.sh passes `-e MARKETING_HOSTS="${MARKETING_HOSTS:-}"`, so an
  // env file with no value yields '' in the container. That used to fall back to
  // a production hostname written into servedHosts.ts; now it means what it says.
  for (const raw of [undefined, '', '   ', '\n', ' , ']) {
    setEnv(raw === undefined ? { NEXTAUTH_URL: 'https://interncrm.com' } : { NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: raw });
    assert.deepEqual([...marketingHosts()], [], `raw=${JSON.stringify(raw)}`);
    assert.deepEqual([...servedHosts()], ['interncrm.com'], `raw=${JSON.stringify(raw)}: only the configured host is served`);
    assert.equal(isServedHost(MKT), false);
  }
});

// The default this file used to carry was one deployment's live domain, so a
// revert or a stale merge resolution would quietly make every other deployment
// claim it again. Guard the source itself: no string literal in servedHosts.ts
// may be a hostname (the local dev origin is a URL, not a bare host).
test('servedHosts.ts carries no hostname literal (#2926)', () => {
  const src = readFileSync(new URL('../../src/lib/servedHosts.ts', import.meta.url), 'utf8');
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const literals = [...code.matchAll(/(['"`])((?:(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]);
  assert.ok(literals.length > 0, 'the scan found the string literals');
  for (const lit of literals) {
    assert.ok(!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(lit.trim()), `hostname literal in servedHosts.ts: ${lit}`);
  }
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
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', NEXT_PUBLIC_APP_URL: 'https://interncrm.com', MARKETING_HOSTS: MKT });
  assert.deepEqual([...servedHosts()].sort(), ['interncrm.com', MKT], 'prod');
  setEnv({ NEXTAUTH_URL: 'https://preview.interncrm.com', NEXT_PUBLIC_APP_URL: 'https://preview.interncrm.com', MARKETING_HOSTS: MKT_PREVIEW });
  assert.deepEqual([...servedHosts()].sort(), [MKT_PREVIEW, 'preview.interncrm.com'], 'preview');
  // A topic env is covered by its OWN NEXTAUTH_URL — no wildcard, no per-PR list —
  // and topic-deploy.sh gives it its own marketing host on the same wildcard.
  setEnv({ NEXTAUTH_URL: 'https://pr123.interncrm.com', NEXT_PUBLIC_APP_URL: 'https://pr123.interncrm.com', MARKETING_HOSTS: 'pr123-m.interncrm.com' });
  assert.deepEqual([...servedHosts()].sort(), ['pr123-m.interncrm.com', 'pr123.interncrm.com'], 'topic');
  assert.ok(!servedHosts().has('pr124.interncrm.com'), 'a sibling topic host is NOT served');
  assert.ok(!servedHosts().has(MKT), 'nor is any other deployment\'s marketing host');
  setEnv({});
  assert.deepEqual([...servedHosts()].sort(), ['localhost'], 'dev without MARKETING_HOSTS');
});

test('isServedHost: exact match on the header hostname, nothing else', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: MKT });
  assert.equal(isServedHost('interncrm.com'), true);
  assert.equal(isServedHost('INTERNCRM.COM:443'), true);
  assert.equal(isServedHost('marketing.example.test'), true);
  assert.equal(isServedHost('interncrm.com.evil.example'), false);
  assert.equal(isServedHost('evil.example'), false);
  assert.equal(isServedHost(''), false);
  assert.equal(isServedHost(undefined), false);
});

test('requestOrigin: the served request host wins; anything else is the configured origin', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: MKT });
  const H = (m) => (n) => m[n] ?? null;
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.example.test', 'x-forwarded-proto': 'https' })), 'https://marketing.example.test');
  assert.equal(requestOrigin(H({ host: 'marketing.example.test' })), 'https://marketing.example.test', 'Host alone works, protocol from config');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'evil.example' })), 'https://interncrm.com');
  assert.equal(requestOrigin(H({})), 'https://interncrm.com');
  // Never downgrade, never trust a received port.
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.example.test:99999', 'x-forwarded-proto': 'http' })), 'https://marketing.example.test');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.example.test, evil.example' })), 'https://marketing.example.test', 'first entry of a proxy list');
  // Dev: the configured port is re-attached for the configured host only.
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000', MARKETING_HOSTS: MKT });
  assert.equal(requestOrigin(H({ host: 'localhost:3000' })), 'http://localhost:3000');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.example.test' })), 'http://marketing.example.test');
  assert.equal(requestOrigin(H({ 'x-forwarded-host': 'marketing.example.test', 'x-forwarded-proto': 'https' })), 'https://marketing.example.test', 'an http deployment may upgrade');
  // Without MARKETING_HOSTS a marketing host is just another unknown host.
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com' });
  assert.equal(requestOrigin(H({ 'x-forwarded-host': MKT, 'x-forwarded-proto': 'https' })), 'https://interncrm.com');
});

test('resolveRedirectTarget: NextAuth-default parity on the internship host', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com' });
  const B = 'https://interncrm.com';
  assert.equal(resolveRedirectTarget('/auth/signin', B), 'https://interncrm.com/auth/signin');
  assert.equal(resolveRedirectTarget('//evil.example', B), 'https://interncrm.com//evil.example', 'a path on our host, exactly as the default');
  assert.equal(resolveRedirectTarget('https://interncrm.com/x?y=1#z', B), 'https://interncrm.com/x?y=1#z', 'same origin is returned verbatim');
});

test('resolveRedirectTarget: a served host is kept, re-assembled; everything else is baseUrl', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: MKT });
  const B = 'https://interncrm.com';
  assert.equal(resolveRedirectTarget('https://marketing.example.test/auth/signin', B), 'https://marketing.example.test/auth/signin');
  assert.equal(resolveRedirectTarget('https://MARKETING.example.test/a?b=1#c', B), 'https://marketing.example.test/a?b=1#c');
  assert.equal(resolveRedirectTarget('https://marketing.example.test:8443/a', B), 'https://marketing.example.test/a', 'a received port is dropped');
  for (const bad of [
    'https://evil.example/',
    'https://interncrm.com.evil.example/',
    'https://interncrm.com@evil.example/',
    'https://marketing.example.test,evil.example/',
    'https://interncrm.com,x/',
    'http://marketing.example.test/',
    'javascript:alert(1)',
    'ftp://marketing.example.test/',
    'not a url',
    '',
  ]) assert.equal(resolveRedirectTarget(bad, B), B, `${JSON.stringify(bad)} must fall back to baseUrl`);
});

test('resolveRedirectTarget on a dev (http) base accepts the base protocol and https', () => {
  setEnv({ NEXTAUTH_URL: 'http://localhost:3000', MARKETING_HOSTS: MKT });
  const B = 'http://localhost:3000';
  assert.equal(resolveRedirectTarget('http://localhost:3000/auth/signin', B), 'http://localhost:3000/auth/signin');
  assert.equal(resolveRedirectTarget('http://marketing.example.test/auth/signin', B), 'http://marketing.example.test/auth/signin');
  assert.equal(resolveRedirectTarget('https://marketing.example.test/auth/signin', B), 'https://marketing.example.test/auth/signin');
  assert.equal(resolveRedirectTarget('http://evil.example/', B), B);
});

// servedOrigin (#2494): SAML RelayState and the Google OAuth state carry the
// origin a sign-in started on through a third party and back. RelayState is
// signed by nobody, so this is the open-redirect boundary for both flows.
test('servedOrigin: a bare origin of a served host is returned, normalised', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: MKT });
  assert.equal(servedOrigin('https://marketing.example.test'), 'https://marketing.example.test');
  assert.equal(servedOrigin('https://MARKETING.example.test/'), 'https://marketing.example.test', 'case and a bare trailing slash');
  assert.equal(servedOrigin('https://interncrm.com'), 'https://interncrm.com');
  assert.equal(servedOrigin('https://interncrm.com:443'), 'https://interncrm.com', 'the default port is no port');
});

test('servedOrigin: anything that is not a bare served origin is refused, never repaired', () => {
  setEnv({ NEXTAUTH_URL: 'https://interncrm.com', MARKETING_HOSTS: MKT });
  for (const bad of [
    null,
    undefined,
    '',
    'not a url',
    '/relative',
    '//marketing.example.test',
    'https://evil.example',
    'https://marketing.example.test.evil.example',
    'https://marketing.example.test@evil.example',
    'https://user:pw@marketing.example.test',
    'https://marketing.example.test,evil.example',
    'https://marketing.example.test/auth/signin',
    'https://marketing.example.test/?next=https://evil.example',
    'https://marketing.example.test/#x',
    'https://marketing.example.test:8443',
    'http://marketing.example.test',
    'javascript:alert(1)',
    'ftp://marketing.example.test',
    'https://marketing.example.test.',
  ]) assert.equal(servedOrigin(bad), null, `${JSON.stringify(bad)} must be refused`);
});

test('servedOrigin on a dev (http) configured origin: its own port on its own host only', () => {
  setEnv({ NEXTAUTH_URL: 'http://localhost:3143', MARKETING_HOSTS: MKT });
  assert.equal(servedOrigin('http://localhost:3143'), 'http://localhost:3143');
  assert.equal(servedOrigin('http://localhost:3143/'), 'http://localhost:3143');
  assert.equal(servedOrigin('http://localhost:9999'), null, 'another port on the same host is not ours');
  assert.equal(servedOrigin('http://marketing.example.test'), 'http://marketing.example.test', 'the base protocol is accepted');
  assert.equal(servedOrigin('https://marketing.example.test'), 'https://marketing.example.test');
  assert.equal(servedOrigin('http://marketing.example.test:3143'), null, 'the configured port is not re-attached to another host');
});

// ── Verified tenant domains (#1661) ──────────────────────────────────────────

test('extraHosts: a verified tenant domain is accepted by exact match — and only while passed in', () => {
  setEnv({ NEXTAUTH_URL: 'https://app.example.test' });
  const tenant = new Set(['careers.acme.example']);
  const base = 'https://app.example.test';
  // Without it, exactly as before.
  assert.equal(resolveRedirectTarget('https://careers.acme.example/auth/signin', base), base);
  assert.equal(servedOrigin('https://careers.acme.example'), null);
  assert.equal(requestOrigin((n) => (n === 'x-forwarded-host' ? 'careers.acme.example' : null)), base);
  // With it.
  assert.equal(resolveRedirectTarget('https://careers.acme.example/auth/signin', base, tenant), 'https://careers.acme.example/auth/signin');
  assert.equal(servedOrigin('https://careers.acme.example', tenant), 'https://careers.acme.example');
  assert.equal(requestOrigin((n) => (n === 'x-forwarded-host' ? 'careers.acme.example' : n === 'x-forwarded-proto' ? 'https' : null), tenant), 'https://careers.acme.example');
  // Still exact: no suffix, no userinfo trick, no sibling.
  for (const evil of ['https://careers.acme.example.evil.test/', 'https://careers.acme.example@evil.test/', 'https://x.careers.acme.example/', 'https://acme.example/']) {
    assert.equal(resolveRedirectTarget(evil, base, tenant), base, evil);
  }
  assert.equal(servedOrigin('https://careers.acme.example/next', tenant), null);
});
