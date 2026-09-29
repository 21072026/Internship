import { test, expect, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { makeUnsubscribeToken } from '../src/lib/unsubscribeToken';

// Host-coherent redirects (#2488). One deployment serves several public hosts
// (interncrm.com + marketing.bcsit-gmbh.de; their preview twins; a topic env's own
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
// does. Locally MARKETING_HOSTS is unset, so its default 'marketing.bcsit-gmbh.de'
// is an allowlisted host without any env change. The client half
// (absoluteHere) is a same-origin no-op on this host and is covered by the
// existing sign-out specs (sign-out-all, account-self-service).

const MARKETING = 'marketing.bcsit-gmbh.de';
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

// ── Flows that leave through a third party and come back (#2494) ────────────
//
// SAML's ACS and Google's OAuth callback are registered under ONE host, so the
// browser returns there whichever host it started on. The originating origin
// rides along (RelayState / the signed OAuth state) and is honoured only when it
// is a bare origin of a host this deployment serves.

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedSamlOrg() {
  const slug = `host-sso-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  // Never contacted: the login route only BUILDS the AuthnRequest URL, and the
  // ACS cases below are refused before any assertion is parsed.
  return prisma.organization.create({
    data: {
      name: `Host SSO ${slug}`,
      slug,
      plan: 'ENTERPRISE',
      ssoEnabled: true,
      ssoProvider: 'saml',
      ssoIssuer: 'https://idp.example/issuer',
      ssoEntryPoint: 'https://idp.example/sso',
      ssoCertificate: 'MIIBdummycertificateNeverParsedByTheLoginRoute',
    },
  });
}

test('SAML login started on the marketing host sends that origin as RelayState; the default host sends none', async ({ request }) => {
  const org = await seedSamlOrg();
  try {
    const marketing = await request.get(`/api/auth/sso/${org.slug}/login`, { headers: AS_MARKETING, maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(marketing.status());
    const idp = new URL(marketing.headers()['location']);
    expect(idp.origin).toBe('https://idp.example');
    expect(idp.searchParams.get('SAMLRequest')).toBeTruthy();
    expect(idp.searchParams.get('RelayState')).toBe(`https://${MARKETING}`);

    // The internship host's AuthnRequest is exactly what it always was.
    const def = await request.get(`/api/auth/sso/${org.slug}/login`, { maxRedirects: 0 });
    const defIdp = new URL(def.headers()['location']);
    expect(defIdp.origin).toBe('https://idp.example');
    expect(defIdp.searchParams.get('RelayState') ?? '').toBe('');
  } finally {
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('the SAML ACS finishes on the RelayState origin only when it is a bare served origin', async ({ request }) => {
  // An unknown slug is refused before any assertion is read — which is enough
  // to see WHERE the refusal sends the browser. The success leg uses the same
  // base() and is driven end to end in sso-roundtrip.spec.ts.
  const acs = (RelayState: string) =>
    request.post('/api/auth/sso/no-such-org/acs', { form: { SAMLResponse: 'x', RelayState }, maxRedirects: 0 });

  const kept = await acs(`https://${MARKETING}`);
  expect(kept.status()).toBe(303);
  const keptLoc = new URL(kept.headers()['location']);
  expect(keptLoc.origin).toBe(`https://${MARKETING}`);
  expect(keptLoc.pathname).toBe('/auth/signin');
  expect(keptLoc.searchParams.get('error')).toBe('sso_unavailable');

  const def = new URL((await acs('')).headers()['location']);
  expect(def.hostname).not.toBe(MARKETING);

  for (const evil of [
    'https://evil.example',
    `https://${MARKETING}.evil.example`,
    `https://${MARKETING}@evil.example`,
    `https://${MARKETING}/auth/signin`,
    `https://${MARKETING}/?next=https://evil.example`,
    `//${MARKETING}`,
    'javascript:alert(1)',
  ]) {
    const loc = new URL((await acs(evil)).headers()['location']);
    expect(loc.origin, evil).toBe(def.origin);
    expect(loc.hostname, evil).not.toContain('evil.example');
  }
});

test('a Google connect started on the marketing host is handed back there by the registered callback', async ({ page }) => {
  const email = uniqueEmail('host-gcal');
  const password = 'HostGcal123!';
  const user = await seedUser(email, password, 'MENTOR', 'Host Gcal');
  try {
    await signInAndSettle(page, email, password, '/mentor');

    // The session cookie is keyed on the real host (localhost); the forged
    // header is what the proxy would say about the host the browser is on.
    const consent = await page.request.get('/api/integrations/google/connect', { headers: AS_MARKETING, maxRedirects: 0 });
    const consentUrl = new URL(consent.headers()['location']);
    test.skip(consentUrl.hostname !== 'accounts.google.com', 'Google Calendar is not enabled on this server');
    const state = consentUrl.searchParams.get('state')!;
    // redirect_uri is the REGISTERED one, whatever host the connect came from.
    expect(new URL(consentUrl.searchParams.get('redirect_uri')!).hostname).not.toBe(MARKETING);

    // Google returns to the registered host: one hop back to the marketing host,
    // query untouched, and nothing done here.
    const query = `code=ok&state=${encodeURIComponent(state)}`;
    const hop = await page.request.get(`/api/integrations/google/callback?${query}`, { maxRedirects: 0 });
    expect([302, 307]).toContain(hop.status());
    const hopLoc = new URL(hop.headers()['location']);
    expect(hopLoc.origin).toBe(`https://${MARKETING}`);
    expect(hopLoc.pathname).toBe('/api/integrations/google/callback');
    expect(hopLoc.searchParams.get('state')).toBe(state);
    expect(hopLoc.searchParams.get('code')).toBe('ok');
    expect(await prisma.googleCalendarConnection.count({ where: { userId: user.id } })).toBe(0);

    // On the marketing host it does not hop again: it finishes there. Connected
    // with the local Google stub running, failed without it — either way the
    // browser ends on the marketing host's /account.
    const done = await page.request.get(`/api/integrations/google/callback?${query}`, { headers: AS_MARKETING, maxRedirects: 0 });
    const doneLoc = new URL(done.headers()['location']);
    expect(doneLoc.origin).toBe(`https://${MARKETING}`);
    expect(doneLoc.pathname).toBe('/account');
    expect(doneLoc.searchParams.get('google')).toMatch(/^(connected|failed)$/);

    // A tampered state is never forwarded anywhere.
    const tampered = await page.request.get(
      `/api/integrations/google/callback?code=ok&state=${encodeURIComponent(state.slice(0, -3) + 'aaa')}`,
      { maxRedirects: 0 }
    );
    const tamperedLoc = new URL(tampered.headers()['location']);
    expect(tamperedLoc.hostname).not.toBe(MARKETING);
    expect(tamperedLoc.searchParams.get('google')).toBe('failed');
  } finally {
    await prisma.googleCalendarConnection.deleteMany({ where: { userId: user.id } });
    await cleanupByEmail(email);
  }
});

// ── E-mail links (#2495) ────────────────────────────────────────────────────

test('the one-click unsubscribe GET forwards with a RELATIVE Location — it stays on the host the mail pointed at', async ({ request }) => {
  const token = makeUnsubscribeToken('host-coherent-user', 'digests');
  for (const headers of [AS_MARKETING, undefined]) {
    const res = await request.get(`/api/unsubscribe/one-click?t=${encodeURIComponent(token)}`, { headers, maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()['location']).toBe(`/u/${encodeURIComponent(token)}`);
  }
});
