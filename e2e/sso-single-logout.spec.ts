import { test, expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { E2E_IDP_MOCK_PORT } from '../playwright.config';

// SAML Single Logout (#1952, docs/sso-saml.md § Single Logout), both
// directions, against the stub IdP (e2e/support/idp-mock.mjs):
//   • IdP-initiated — a signed LogoutRequest ends every session AND remembered
//     device of that person; unsigned, wrongly signed or foreign-subject
//     requests change nothing;
//   • SP-initiated — signing out in the app ends the same things locally FIRST,
//     then sends the browser to the IdP with a signed LogoutRequest.

const MOCK = `http://127.0.0.1:${E2E_IDP_MOCK_PORT}`;
const PASSWORD = 'SloPass123!';
const emails: string[] = [];
const orgIds: string[] = [];

interface IdpState { samlIssuer: string; samlSsoUrl: string; samlCertificate: string }
let idp: IdpState;

test.beforeAll(async () => {
  idp = (await (await fetch(`${MOCK}/__state`)).json()) as IdpState;
});

test.afterAll(async () => {
  for (const email of emails) await cleanupByEmail(email);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

/**
 * An SSO tenant on the stub IdP, seeded behind the write boundary (the stub
 * serves http, and the https rule is the feature — e2e/sso-roundtrip.spec.ts).
 * Not enforced, so its people can also sign in with a password — which is how
 * these specs get a remembered device to revoke.
 */
async function seedSloOrg(prefix: string, ssoLogoutUrl: string | null = `${MOCK}/saml/slo`) {
  const slug = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: {
      name: `SLO ${slug}`,
      slug,
      plan: 'ENTERPRISE',
      ssoEnabled: true,
      ssoProvider: 'saml',
      ssoIssuer: idp.samlIssuer,
      ssoEntryPoint: idp.samlSsoUrl,
      ssoCertificate: idp.samlCertificate,
      ssoLogoutUrl,
    },
  });
  orgIds.push(org.id);
  return org;
}

async function seedMember(orgId: string, prefix: string) {
  const email = uniqueEmail(prefix);
  emails.push(email);
  const user = await seedUser(email, PASSWORD, 'MENTEE', 'SLO Member');
  await prisma.user.update({ where: { id: user.id }, data: { orgId } });
  return { id: user.id, email };
}

async function signInRemembered(page: Page, email: string) {
  await gotoSettled(page, '/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.getByTestId('remember-me').check();
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function sessionEmail(page: Page): Promise<string | null> {
  const s = await (await page.request.get('/api/auth/session')).json();
  return s?.user?.email ?? null;
}

const liveDevices = (userId: string) => prisma.trustedDevice.count({ where: { userId, revokedAt: null } });

async function mintLogoutRequest(body: Record<string, unknown>) {
  const res = await fetch(`${MOCK}/saml/logout-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { query?: string; SAMLRequest?: string };
}

test('IdP-initiated: only a verified LogoutRequest for this org ends sessions and remembered devices', { tag: '@smoke' }, async ({ page }) => {
  const org = await seedSloOrg('slo-idp');
  const other = await seedSloOrg('slo-other');
  const member = await seedMember(org.id, 'slo-member');
  const outsider = await seedMember(other.id, 'slo-outsider');
  const slo = `/api/auth/sso/${org.slug}/slo`;
  const destination = `http://localhost/api/auth/sso/${org.slug}/slo`;

  await signInRemembered(page, member.email);
  expect(await sessionEmail(page)).toBe(member.email);
  expect(await liveDevices(member.id)).toBeGreaterThan(0);

  // Refused, and nothing changes: unsigned (node-saml alone would accept an
  // unsigned redirect), signed by a key the tenant never trusted, unsigned POST.
  for (const mode of ['unsigned', 'wrong-key']) {
    const { query } = await mintLogoutRequest({ destination, email: member.email, mode });
    const res = await page.request.get(`${slo}?${query}`, { maxRedirects: 0 });
    expect(res.status(), mode).toBe(400);
    expect((await res.json()).code, mode).toBe('slo_refused');
  }
  const unsignedPost = await mintLogoutRequest({ destination, email: member.email, mode: 'post-unsigned' });
  expect((await page.request.post(slo, { form: { SAMLRequest: unsignedPost.SAMLRequest! }, maxRedirects: 0 })).status()).toBe(400);
  expect(await sessionEmail(page)).toBe(member.email);
  expect(await liveDevices(member.id)).toBeGreaterThan(0);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).sessionsValidFrom).toBeNull();

  // Parameter smuggling: a genuinely signed request for one person, with a
  // second SAMLRequest naming somebody else appended. The signature covers the
  // first; the message must never be read from the second (#1952 follow-up).
  const colleague = await seedMember(org.id, 'slo-colleague');
  const own = await mintLogoutRequest({ destination, email: colleague.email });
  const smuggled = await mintLogoutRequest({ destination, email: member.email, mode: 'unsigned' });
  const injected = `${own.query}&${smuggled.query!.split('&')[0]}`;
  const smuggle = await page.request.get(`${slo}?${injected}`, { maxRedirects: 0 });
  expect(smuggle.status()).toBe(400);
  expect((await smuggle.json()).code).toBe('slo_refused');
  expect(await sessionEmail(page)).toBe(member.email);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).sessionsValidFrom).toBeNull();
  expect((await prisma.user.findUniqueOrThrow({ where: { id: colleague.id } })).sessionsValidFrom).toBeNull();

  // A genuine request naming another tenant's user, sent through THIS tenant's
  // endpoint, touches nobody — and still answers like any other.
  const foreign = await mintLogoutRequest({ destination, email: outsider.email });
  expect((await page.request.get(`${slo}?${foreign.query}`, { maxRedirects: 0 })).status()).toBe(303);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: outsider.id } })).sessionsValidFrom).toBeNull();
  expect(await sessionEmail(page)).toBe(member.email);

  // The real thing, through the browser as an IdP sends it.
  const { query } = await mintLogoutRequest({ destination, email: member.email, relayState: 'rs-1' });
  await page.goto(`${slo}?${query}`);
  await expect(page.getByTestId('stub-idp-signed-out')).toBeVisible();
  const answer = (await (await fetch(`${MOCK}/saml/slo/last`)).json()) as { kind: string; xml: string; signed: boolean; rawQuery: string };
  expect(answer.kind).toBe('response');
  expect(answer.signed).toBe(true);
  expect(answer.xml).toContain('urn:oasis:names:tc:SAML:2.0:status:Success');
  expect(answer.rawQuery).toContain('RelayState=rs-1');

  expect(await sessionEmail(page)).toBeNull();
  expect(await liveDevices(member.id)).toBe(0);
  // The remembered device must not mint a new session on the next page load.
  await page.goto('/portal');
  await page.waitForURL((u) => u.pathname.startsWith('/auth'), { timeout: 20_000 });
  expect(await sessionEmail(page)).toBeNull();
  expect(await prisma.activityLog.count({ where: { action: 'auth.slo', targetId: member.id } })).toBe(1);
});

test('IdP-initiated over the POST binding is verified the same way; an enforced org leaves only the IdP', async ({ request }) => {
  const org = await seedSloOrg('slo-post');
  // Enforced SSO (#1950): after the SLO, no password door reopens the session.
  await prisma.organization.update({ where: { id: org.id }, data: { ssoEnforced: true } });
  const member = await seedMember(org.id, 'slo-post-member');
  const { SAMLRequest } = await mintLogoutRequest({
    destination: `http://localhost/api/auth/sso/${org.slug}/slo`,
    email: member.email,
    mode: 'post',
  });
  const res = await request.post(`/api/auth/sso/${org.slug}/slo`, { form: { SAMLRequest: SAMLRequest! }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers()['location']).toContain(`${MOCK}/saml/slo?SAMLResponse=`);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).sessionsValidFrom).not.toBeNull();
  const again = await signInViaApi(request, member.email, PASSWORD);
  expect(again.ok).toBe(false);
  expect(again.error).toBe('SSO_REQUIRED');
});

test('SP-initiated: signing out ends sessions and devices here first, then signs the LogoutRequest to the IdP', { tag: '@smoke' }, async ({ page }) => {
  const org = await seedSloOrg('slo-sp');
  const member = await seedMember(org.id, 'slo-sp-member');
  await signInRemembered(page, member.email);
  expect(await liveDevices(member.id)).toBeGreaterThan(0);

  await page.getByTestId('account-menu-button').click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await expect(page.getByTestId('stub-idp-signed-out')).toBeVisible({ timeout: 20_000 });

  const sent = (await (await fetch(`${MOCK}/saml/slo/last`)).json()) as { kind: string; xml: string; signed: boolean };
  expect(sent.kind).toBe('request');
  expect(sent.signed).toBe(true);
  expect(sent.xml).toContain('LogoutRequest');
  expect(sent.xml).toContain(member.email);
  expect(sent.xml).toContain(`/sso/${org.slug}`);

  // Locally signed out everywhere, before the IdP was ever reached.
  const row = await prisma.user.findUniqueOrThrow({ where: { id: member.id } });
  expect(row.sessionsValidFrom).not.toBeNull();
  expect(await liveDevices(member.id)).toBe(0);
  expect(await sessionEmail(page)).toBeNull();

  // The SP metadata publishes our SLO endpoint and the certificate the IdP
  // verifies these signatures with.
  const metadata = await (await page.request.get(`/api/auth/sso/${org.slug}/metadata`)).text();
  expect(metadata).toContain(`/api/auth/sso/${org.slug}/slo`);
  expect(metadata).toContain('SingleLogoutService');
  expect(metadata).toMatch(/<md:KeyDescriptor use="signing">[\s\S]*X509Certificate>[A-Za-z0-9+/=]{200,}</);
  expect(metadata.indexOf('SingleLogoutService')).toBeLessThan(metadata.indexOf('NameIDFormat'));
});

test('SP-initiated with an unreachable IdP: the local sign-out still completes', async ({ page }) => {
  const org = await seedSloOrg('slo-down', 'https://idp-unreachable.invalid/slo');
  const member = await seedMember(org.id, 'slo-down-member');
  await signInRemembered(page, member.email);

  const res = await page.request.post('/api/auth/sso/logout');
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).redirect).toMatch(/^https:\/\/idp-unreachable\.invalid\/slo\?SAMLRequest=/);
  // Whatever happens at the IdP, we are already signed out.
  expect(await sessionEmail(page)).toBeNull();
  expect(await liveDevices(member.id)).toBe(0);
});

test('an org without an IdP logout URL signs out locally only', async ({ page }) => {
  const org = await seedSloOrg('slo-none', null);
  const member = await seedMember(org.id, 'slo-none-member');
  await signInRemembered(page, member.email);
  const res = await page.request.post('/api/auth/sso/logout');
  expect((await res.json()).redirect).toBeNull();
  // Nothing was revoked by this call — the ordinary sign-out does that per device.
  expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).sessionsValidFrom).toBeNull();
});
