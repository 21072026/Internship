import { test, expect, type APIRequestContext } from '@playwright/test';

// Host-coherent redirects (#2488). One deployment serves several public hosts
// (interncrm.com + marketing.ersah.in; their preview twins; a topic env's own
// pr<N> host). NextAuth resolves every callbackUrl against NEXTAUTH_URL — the
// internship host — and never sees the request, so a marketing visitor who
// signed out used to land on the internship product. The fix: the client sends
// an absolute same-origin callbackUrl, and `callbacks.redirect` keeps it iff its
// host is one this deployment serves (src/lib/servedHosts.ts); server-side
// redirects derive their origin from the validated request host the same way.
//
// The browser in Playwright is always on localhost, so the server half — the
// allowlist through the real NextAuth stack and the real route handlers — is
// proven with forged proxy headers, exactly as host-vertical-landing.spec.ts
// does. Locally MARKETING_HOSTS is unset, so its default 'marketing.ersah.in'
// is an allowlisted host without any env change. The client half
// (absoluteHere) is a same-origin no-op on this host and is covered by the
// existing sign-out specs (sign-out-all, account-self-service).

const MARKETING = 'marketing.ersah.in';
const AS_MARKETING = { 'x-forwarded-host': MARKETING, 'x-forwarded-proto': 'https' };

async function signOutUrl(request: APIRequestContext, callbackUrl: string, headers?: Record<string, string>) {
  const csrf = await request.get('/api/auth/csrf', { headers });
  expect(csrf.ok()).toBeTruthy();
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const res = await request.post('/api/auth/signout', { headers, form: { csrfToken, callbackUrl, json: 'true' } });
  expect(res.ok(), `signout POST for ${callbackUrl}`).toBeTruthy();
  return ((await res.json()) as { url: string }).url;
}

test('a sign-out callbackUrl on a served host is kept — the marketing visitor stays on the marketing host', async ({ request }) => {
  const url = await signOutUrl(request, `https://${MARKETING}/auth/signin`, AS_MARKETING);
  expect(url).toBe(`https://${MARKETING}/auth/signin`);
});

test('a sign-out callbackUrl on a host we do not serve falls back to baseUrl — no open redirect', async ({ request }) => {
  const base = await signOutUrl(request, '/');
  for (const evil of [
    'https://evil.example/',
    `https://${MARKETING}.evil.example/`,
    `https://interncrm.com@evil.example/`,
    `https://${MARKETING},evil.example/`,
  ]) {
    const url = await signOutUrl(request, evil, AS_MARKETING);
    expect(url, evil).not.toContain('evil.example');
    expect(new URL(url).origin, evil).toBe(new URL(base).origin);
  }
});

test('a relative sign-out callbackUrl still resolves against baseUrl — NextAuth default parity', async ({ request }) => {
  const url = await signOutUrl(request, '/auth/signin');
  const base = await signOutUrl(request, '/');
  expect(new URL(url).pathname).toBe('/auth/signin');
  expect(new URL(url).origin).toBe(new URL(base).origin);
});

test('the SSO login failure redirect stays on the host the browser is on', async ({ request }) => {
  const marketing = await request.get('/api/auth/sso/no-such-org/login', { headers: AS_MARKETING, maxRedirects: 0 });
  expect([302, 303, 307, 308]).toContain(marketing.status());
  // Parsed, not regex-matched: building a RegExp from the host constant trips
  // CodeQL's incomplete-escaping rule (dots escaped, backslashes not), and the
  // URL parser is what the browser will act on anyway.
  const loc = new URL(marketing.headers()['location']);
  expect(loc.origin, 'marketing host').toBe(`https://${MARKETING}`);
  expect(loc.pathname).toBe('/auth/signin');
  expect(loc.searchParams.get('error')).toBe('sso_unavailable');

  const def = await request.get('/api/auth/sso/no-such-org/login', { maxRedirects: 0 });
  const defLoc = new URL(def.headers()['location']);
  expect(defLoc.hostname, 'default host is not the marketing host').not.toBe(MARKETING);
  expect(defLoc.pathname).toBe('/auth/signin');
  expect(defLoc.searchParams.get('error')).toBe('sso_unavailable');
});

test('the release-notes feed link is built on the host the page was served from', async ({ request }) => {
  const marketing = await (await request.get('/release-notes', { headers: AS_MARKETING })).text();
  expect(marketing).toContain(`https://${MARKETING}/release-notes/feed.xml`);

  const def = await (await request.get('/release-notes')).text();
  expect(def).not.toContain(`${MARKETING}/release-notes/feed.xml`);
  expect(def).toContain('/release-notes/feed.xml');
});

test('a forged host we do not serve is ignored — the redirect origin is the configured one', async ({ request }) => {
  const res = await request.get('/api/auth/sso/no-such-org/login', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, maxRedirects: 0 });
  const loc = new URL(res.headers()['location']);
  expect(loc.hostname).not.toBe('evil.example');
  const def = await request.get('/api/auth/sso/no-such-org/login', { maxRedirects: 0 });
  expect(loc.origin).toBe(new URL(def.headers()['location']).origin);
});
