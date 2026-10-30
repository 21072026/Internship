import { test, expect, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { E2E_IDP_MOCK_PORT } from '../playwright.config';
import { AUTH_SSO_REQUIRED } from '../src/lib/authErrors';

/**
 * Per-tenant SSO discovery (#1665): on a tenant's own VERIFIED host,
 * /auth/signin leads with "Continue with <tenant> SSO" and /auth/sso skips the
 * organisation-code prompt. On the default host, an unverified domain or a
 * tenant whose SSO is off, nothing changes — the code form is still there, so
 * there is no dead end. With enforcement on, the password door is refused by
 * the SERVER for the tenant's users (#1950), not merely de-emphasised.
 *
 * Hosts are reserved example names (RFC 2606), reached with X-Forwarded-Host
 * the way the reverse proxy sends them.
 */

const MOCK = `http://127.0.0.1:${E2E_IDP_MOCK_PORT}`;
const PASSWORD = 'Discover123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedTenant(prefix: string, opts: { verified: boolean; ssoEnabled: boolean; enforced?: boolean }) {
  const idp = await (await fetch(`${MOCK}/__state`)).json();
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const host = `${prefix}-${stamp}.tenant.example.test`;
  const org = await prisma.organization.create({
    data: {
      name: `Discovery ${stamp}`,
      slug: `${prefix}-${stamp}`,
      brandName: `Acme ${stamp}`,
      plan: 'ENTERPRISE',
      publicHost: host,
      publicHostToken: 'tok',
      publicHostVerifiedAt: opts.verified ? new Date() : null,
      ssoEnabled: opts.ssoEnabled,
      ssoEnforced: !!opts.enforced,
      ssoProvider: 'saml',
      ssoIssuer: idp.samlIssuer,
      ssoEntryPoint: idp.samlSsoUrl,
      ssoCertificate: idp.samlCertificate,
    },
  });
  return { org, host };
}

const page = async (request: APIRequestContext, path: string, host?: string) => {
  const res = await request.get(path, { headers: host ? { 'x-forwarded-host': host } : {}, maxRedirects: 0 });
  return { status: res.status(), location: res.headers()['location'] ?? null, html: res.status() === 200 ? await res.text() : '' };
};

test.beforeEach(() => {
  test.skip(!!process.env.BASE_URL, 'the stub IdP only runs under the local webServer');
});

test('SSO discovery: a verified tenant host offers its SSO and /auth/sso skips the code prompt; other hosts are unchanged', { tag: '@smoke' }, async ({ request }) => {
  const live = await seedTenant('disc-live', { verified: true, ssoEnabled: true });
  const unverified = await seedTenant('disc-unver', { verified: false, ssoEnabled: true });
  const off = await seedTenant('disc-off', { verified: true, ssoEnabled: false });
  try {
    // The tenant's own verified host.
    const signin = await page(request, '/auth/signin', live.host);
    expect(signin.status).toBe(200);
    expect(signin.html).toContain('data-testid="tenant-sso-continue"');
    expect(signin.html).toContain(`/api/auth/sso/${live.org.slug}/login`);
    expect(signin.html).toContain(`Acme ${live.org.slug.slice('disc-live-'.length)}`);
    expect(signin.html).not.toContain('data-testid="tenant-sso-enforced"');
    const sso = await page(request, '/auth/sso', live.host);
    expect(sso.status).toBeGreaterThanOrEqual(300);
    expect(sso.status).toBeLessThan(400);
    expect(sso.location).toContain(`/api/auth/sso/${live.org.slug}/login`);

    // The default host: the code form, no tenant button.
    const plain = await page(request, '/auth/signin');
    expect(plain.html).not.toContain('data-testid="tenant-sso-continue"');
    const plainSso = await page(request, '/auth/sso');
    expect(plainSso.status).toBe(200);
    expect(plainSso.html).toContain('data-testid="sso-slug-input"');

    // An unverified claim names nobody — pointing a domain at us is not enough.
    expect((await page(request, '/auth/signin', unverified.host)).html).not.toContain('data-testid="tenant-sso-continue"');
    expect((await page(request, '/auth/sso', unverified.host)).status).toBe(200);

    // SSO configured but switched off: password sign-in and the code form, no dead end.
    expect((await page(request, '/auth/signin', off.host)).html).not.toContain('data-testid="tenant-sso-continue"');
    const offSso = await page(request, '/auth/sso', off.host);
    expect(offSso.status).toBe(200);
    expect(offSso.html).toContain('data-testid="sso-slug-input"');
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: [live.org.id, unverified.org.id, off.org.id] } } });
  }
});

test('SSO discovery: with enforcement the tenant host says so, and a password sign-in by its user is refused by the server', { tag: '@smoke' }, async ({ request }) => {
  const tenant = await seedTenant('disc-enf', { verified: true, ssoEnabled: true, enforced: true });
  const email = uniqueEmail('disc-enf-user').toLowerCase();
  try {
    await seedUser(email, PASSWORD, 'MENTEE', 'Enforced User', tenant.org.id);
    const signin = await page(request, '/auth/signin', tenant.host);
    expect(signin.html).toContain('data-testid="tenant-sso-continue"');
    expect(signin.html).toContain('data-testid="tenant-sso-enforced"');

    // The control is the server's refusal, not the notice.
    const attempt = await signInViaApi(request, email, PASSWORD);
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toBe(AUTH_SSO_REQUIRED);
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: tenant.org.id } });
  }
});
