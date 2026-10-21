import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, signInViaApi } from './helpers/auth';
import { testCertificate, idpMetadataXml } from './support/x509.mjs';
import { E2E_IDP_MOCK_PORT } from '../playwright.config';

// Self-service SSO onboarding (#1933): IdP metadata import (preview only, the
// write stays on the one validated PATCH), the certificate checked at save
// time, the expiry badge, the 30/7-day warning job and "Test connection".
// docs/sso-saml.md § IdP metadata import.

const PASSWORD = 'MetaPass123!';
const MOCK = `http://127.0.0.1:${E2E_IDP_MOCK_PORT}`;
const emails: string[] = [];
const orgIds: string[] = [];

test.afterAll(async () => {
  for (const email of emails) await cleanupByEmail(email);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

async function seedOrg(tag: string, data: Record<string, unknown> = {}) {
  const slug = `e2e-meta-${tag}-${Date.now()}`;
  const org = await prisma.organization.create({ data: { slug, name: `Meta ${tag} ${Date.now()}`, plan: 'ENTERPRISE', ...data } });
  orgIds.push(org.id);
  return org;
}

async function seedAccount(prefix: string, role: 'ADMIN' | 'MENTEE', opts: { superAdmin?: boolean; orgId?: string } = {}) {
  const email = uniqueEmail(prefix);
  emails.push(email);
  const user = await seedUser(email, PASSWORD, role, 'Meta User');
  await prisma.user.update({
    where: { id: user.id },
    data: { ...(opts.superAdmin ? { isSuperAdmin: true } : {}), ...(opts.orgId ? { orgId: opts.orgId } : {}) },
  });
  return email;
}

/** A second, API-only identity next to the page's (its own cookie jar). */
async function apiAs(playwright: { request: { newContext(o: { baseURL?: string }): Promise<APIRequestContext> } }, email: string) {
  const ctx = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  const signedIn = await signInViaApi(ctx, email, PASSWORD);
  expect(signedIn.ok, signedIn.error ?? '').toBe(true);
  return ctx;
}

async function signInAdmin(page: Page, prefix: string, opts: { superAdmin?: boolean; orgId?: string } = {}) {
  const email = uniqueEmail(prefix);
  emails.push(email);
  const user = await seedUser(email, PASSWORD, 'ADMIN', 'Meta Admin');
  await prisma.user.update({
    where: { id: user.id },
    data: { ...(opts.superAdmin ? { isSuperAdmin: true } : {}), ...(opts.orgId ? { orgId: opts.orgId } : {}) },
  });
  await signInAndSettle(page, email, PASSWORD, '/admin');
  return user;
}

const META = (certificate: string) =>
  idpMetadataXml({
    entityId: 'https://idp.meta.example/entity',
    ssoUrl: 'https://idp.meta.example/sso',
    sloUrl: 'https://idp.meta.example/slo',
    certificate,
  });

test('metadata import previews, refuses XXE and private URLs, and is the operator\'s alone', { tag: '@smoke' }, async ({ page, request, playwright }) => {
  const org = await seedOrg('import');
  const url = `/api/admin/organizations/${org.id}/sso/metadata`;

  // Anonymous: refused before anything is read.
  expect((await request.post(url, { data: { xml: META(testCertificate(365)) } })).status()).toBe(401);

  await signInAdmin(page, 'meta-super', { superAdmin: true });
  const cert = testCertificate(365, 'meta-idp');
  const ok = await page.request.post(url, { data: { xml: META(cert) } });
  expect(ok.status()).toBe(200);
  const { preview } = await ok.json();
  expect(preview.ssoProvider).toBe('saml');
  expect(preview.ssoIssuer).toBe('https://idp.meta.example/entity');
  expect(preview.ssoEntryPoint).toBe('https://idp.meta.example/sso');
  expect(preview.sloUrl).toBe('https://idp.meta.example/slo');
  expect(preview.ssoCertificate.replace(/\s+/g, '')).toBe(cert.replace(/\s+/g, ''));
  expect(preview.certificates[0].status).toBe('valid');
  expect(preview.certificates[0].fingerprintSha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

  // A preview writes nothing.
  const untouched = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
  expect(untouched.ssoIssuer).toBeNull();
  expect(untouched.ssoCertificate).toBeNull();

  // XXE: an external entity is refused outright, never resolved.
  const xxe = `<?xml version="1.0"?>\n<!DOCTYPE md [ <!ENTITY xxe SYSTEM "${MOCK}/__state"> ]>\n${META(cert).replace(/^<\?xml[^>]*>\s*/, '').replace('https://idp.meta.example/entity', '&xxe;')}`;
  const refused = await page.request.post(url, { data: { xml: xxe } });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).code).toBe('dtd_not_allowed');

  // SSRF: a metadata URL on a private address — the stub IdP on loopback,
  // plain http or https — is refused by the guard, not fetched.
  for (const target of [`${MOCK}/__state`, `https://127.0.0.1:${E2E_IDP_MOCK_PORT}/metadata`, 'https://169.254.169.254/latest/meta-data/']) {
    const res = await page.request.post(url, { data: { url: target } });
    expect(res.status(), target).toBe(400);
    expect((await res.json()).code, target).toBe('fetch_blocked');
  }

  // The org's own ADMIN may not import an IdP they could never apply (#1575).
  const tenant = await apiAs(playwright, await seedAccount('meta-tenant', 'ADMIN', { orgId: org.id }));
  try {
    const own = await tenant.post(url, { data: { xml: META(cert) } });
    expect(own.status()).toBe(403);
    expect((await own.json()).code).toBe('sso_super_admin_only');
  } finally {
    await tenant.dispose();
  }
});

test('the certificate is checked at save time: unparseable and expired are refused, naming why', { tag: '@smoke' }, async ({ page }) => {
  const org = await seedOrg('save');
  await signInAdmin(page, 'meta-save', { superAdmin: true });
  const base = { id: org.id, ssoProvider: 'saml', ssoIssuer: 'https://idp.save.example/e', ssoEntryPoint: 'https://idp.save.example/sso' };

  const garbage = await page.request.patch('/api/admin/organizations', {
    data: { ...base, ssoCertificate: '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----' },
  });
  expect(garbage.status()).toBe(400);
  expect((await garbage.json()).error).toMatch(/could not be parsed/i);

  const expired = await page.request.patch('/api/admin/organizations', {
    data: { ...base, ssoCertificate: testCertificate(-3, 'expired-idp') },
  });
  expect(expired.status()).toBe(400);
  expect((await expired.json()).error).toMatch(/expired on \d{4}-\d{2}-\d{2}/i);
  expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).ssoCertificate).toBeNull();

  const good = await page.request.patch('/api/admin/organizations', {
    data: { ...base, ssoEnabled: true, ssoCertificate: testCertificate(20, 'soon-idp') },
  });
  expect(good.ok()).toBeTruthy();

  // The list exposes the expiry (never the body) for the badge.
  const listed = await (await page.request.get('/api/admin/organizations')).json();
  const row = listed.organizations.find((o: { id: string }) => o.id === org.id);
  expect(row.sso.certificate).toMatchObject({ invalid: false, status: 'expiring', daysLeft: 20 });
  expect(JSON.stringify(row.sso)).not.toContain('BEGIN CERTIFICATE');

  // A tenant whose certificate has since lapsed can still switch SSO off.
  await prisma.organization.update({ where: { id: org.id }, data: { ssoCertificate: testCertificate(-1, 'lapsed-idp') } });
  expect((await page.request.patch('/api/admin/organizations', { data: { id: org.id, ssoEnabled: false } })).ok()).toBeTruthy();
});

test('import fills the card, Save stores it and the badge shows the expiry', async ({ page }) => {
  const org = await seedOrg('ui');
  await signInAdmin(page, 'meta-ui', { superAdmin: true });
  await gotoSettled(page, '/admin/organizations');
  await page.getByTestId('sso-org-select').selectOption(org.id);

  await page.getByTestId('sso-metadata-xml').fill(META(testCertificate(20, 'ui-idp')));
  await page.getByTestId('sso-metadata-read').click();
  const preview = page.getByTestId('sso-metadata-preview');
  await expect(preview).toContainText('https://idp.meta.example/entity');
  await expect(preview.getByTestId('sso-cert-badge')).toHaveAttribute('data-status', 'expiring');
  // Nothing is written by reading.
  expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).ssoIssuer).toBeNull();

  await page.getByTestId('sso-metadata-apply').click();
  await expect(page.getByTestId('sso-metadata-applied')).toBeVisible();
  await page.getByTestId('sso-save').click();
  await expect.poll(async () => (await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).ssoEntryPoint, { timeout: 10_000 })
    .toBe('https://idp.meta.example/sso');
  const saved = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
  expect(saved.ssoIssuer).toBe('https://idp.meta.example/entity');
  expect(saved.ssoProvider).toBe('saml');
  // The IdP's SingleLogoutService rides along (#1952).
  expect(saved.ssoLogoutUrl).toBe('https://idp.meta.example/slo');
  expect(saved.ssoCertificate).toContain('BEGIN CERTIFICATE');

  // The card's own badge, from the stored certificate.
  const cardBadge = page.locator('[data-testid="sso-cert-badge"]').first();
  await expect(cardBadge).toHaveAttribute('data-status', 'expiring');
  await expect(cardBadge).toContainText('20');
});

test('test connection reports each step, mints no session, and is admin-only', { tag: '@smoke' }, async ({ page, request, playwright }) => {
  const idp = (await (await fetch(`${MOCK}/__state`)).json()) as { samlIssuer: string; samlSsoUrl: string };
  // Seeded behind the write boundary: the stub cannot serve TLS, and the
  // https rule is the feature (e2e/sso-roundtrip.spec.ts explains).
  const org = await seedOrg('test', {
    ssoEnabled: true,
    ssoProvider: 'saml',
    ssoIssuer: idp.samlIssuer,
    ssoEntryPoint: idp.samlSsoUrl,
    ssoCertificate: testCertificate(90, 'test-conn-idp'),
  });
  const url = `/api/admin/organizations/${org.id}/sso/test`;
  expect((await request.post(url)).status()).toBe(401);

  // A tenant admin may test their own org's connection…
  await signInAdmin(page, 'meta-conn', { orgId: org.id });
  const grantsBefore = await prisma.ssoLoginGrant.count();
  const res = await page.request.post(url);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const check = (name: string) => body.checks.find((c: { check: string }) => c.check === name);
  expect(check('config_complete').ok).toBe(true);
  expect(check('certificate').ok).toBe(true);
  expect(check('authn_request').ok).toBe(true);
  // …and the probe goes through the SSRF guard: the loopback stub is refused,
  // so the test reports the exact failure rather than reaching it.
  expect(check('entry_point').ok).toBe(false);
  expect(check('entry_point').detail).toMatch(/^fetch_blocked/);
  expect(body.ok).toBe(false);
  // No grant, no user, no session came out of it.
  expect(await prisma.ssoLoginGrant.count()).toBe(grantsBefore);
  expect(await prisma.user.count({ where: { orgId: org.id } })).toBe(1);
  expect(res.headers()['set-cookie'] ?? '').not.toContain('next-auth.session-token');

  // …but not a foreign org's, and a non-admin not at all.
  const foreign = await seedOrg('foreign');
  expect((await page.request.post(`/api/admin/organizations/${foreign.id}/sso/test`)).status()).toBe(403);
  const mentee = await apiAs(playwright, await seedAccount('meta-mentee', 'MENTEE'));
  try {
    expect((await mentee.post(url)).status()).toBe(401);
  } finally {
    await mentee.dispose();
  }
});

test('expiry warnings: one mail at 30 days, one at 7, none repeated, a new certificate restarts', async ({ page }) => {
  const supportEmail = uniqueEmail('meta-support');
  const org = await seedOrg('warn', {
    ssoEnabled: true,
    ssoProvider: 'saml',
    ssoIssuer: 'https://idp.warn.example/e',
    ssoEntryPoint: 'https://idp.warn.example/sso',
    ssoCertificate: testCertificate(25, 'warn-idp'),
    supportEmail,
  });
  await signInAdmin(page, 'meta-warn', { superAdmin: true });
  const run = async (daysAhead = 0) => {
    const at = new Date(Date.now() + daysAhead * 86_400_000).toISOString();
    const res = await page.request.get(`/api/cron?job=sso-certificates&orgId=${org.id}&at=${encodeURIComponent(at)}`);
    expect(res.ok()).toBeTruthy();
    return (await res.json()).ssoCertificates as { checked: number; warned: number };
  };
  const row = () => prisma.organization.findUniqueOrThrow({ where: { id: org.id } });

  expect(await run()).toMatchObject({ checked: 1, warned: 1 });
  expect((await row()).ssoCertWarnStage).toBe(30);
  expect((await run()).warned).toBe(0); // not a daily nag
  expect((await run(1)).warned).toBe(0);
  expect((await run(19)).warned).toBe(1); // 6 days left: the 7-day mail
  expect((await row()).ssoCertWarnStage).toBe(7);
  expect((await run(20)).warned).toBe(0);
  expect((await run(40)).warned).toBe(0); // expired: no "will expire" mail

  const warnings = await prisma.activityLog.count({ where: { action: 'sso.certificate_expiring', targetId: org.id } });
  expect(warnings).toBe(2);

  // A rotated certificate (another fingerprint) starts afresh.
  await prisma.organization.update({ where: { id: org.id }, data: { ssoCertificate: testCertificate(10, 'rotated-idp') } });
  expect((await run()).warned).toBe(1);
  expect((await row()).ssoCertWarnStage).toBe(30);
});
