import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { E2E_IDP_MOCK_PORT } from '../playwright.config';

/**
 * SSO directory sync (#1943), end to end against the stub IdP.
 *
 * The tenant admin maps IdP claims to profile fields through the API, the stub
 * signs assertions carrying those attributes, and the ACS refreshes the profile
 * on EVERY sign-in — not only the first. The rule (allowlist, value
 * normalisation, the photo's shape) is unit-tested in
 * scripts/test/sso-directory-sync.test.mjs; this proves the chain and the two
 * boundaries that only the running app can: the overwrite policy against a
 * value the person changed, and the SSRF guard on a photo URL — which must
 * refuse the photo without refusing the sign-in.
 */

const MOCK = `http://127.0.0.1:${E2E_IDP_MOCK_PORT}`;
const PASSWORD = 'DirSync123!';
// The smallest PNG signature the sniffer accepts, as an AD thumbnailPhoto would arrive.
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).toString('base64');

let idp: { samlIssuer: string; samlSsoUrl: string; samlCertificate: string };

test.beforeEach(() => {
  test.skip(!!process.env.BASE_URL, 'the stub IdP only runs under the local webServer');
});

test.beforeAll(async () => {
  if (process.env.BASE_URL) return;
  idp = await (await fetch(`${MOCK}/__state`)).json();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedOrg(prefix: string) {
  const slug = `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  return prisma.organization.create({
    data: {
      name: `SSO ${slug}`,
      slug,
      plan: 'ENTERPRISE',
      ssoEnabled: true,
      ssoProvider: 'saml',
      ssoIssuer: idp.samlIssuer,
      ssoEntryPoint: idp.samlSsoUrl,
      ssoCertificate: idp.samlCertificate,
    },
  });
}

async function adminContext(orgId: string, email: string) {
  await seedUser(email, PASSWORD, 'ADMIN', 'Dir Sync Admin', orgId);
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const signIn = await signInViaApi(ctx, email, PASSWORD);
  expect(signIn.ok, `admin sign-in failed: ${signIn.error}`).toBe(true);
  return ctx;
}

/** One SP-initiated round trip, browserless: login route → stub mint → ACS. */
async function ssoSignIn(request: APIRequestContext, slug: string, email: string, attributes: Record<string, string | string[]>) {
  const login = await request.get(`/api/auth/sso/${slug}/login`, { maxRedirects: 0 });
  const samlRequest = new URL(login.headers()['location']).searchParams.get('SAMLRequest');
  expect(samlRequest).toBeTruthy();
  const minted = await request.post(`${MOCK}/saml/mint`, { data: { samlRequest, email, name: 'Dir Synced', attributes } });
  expect(minted.ok()).toBeTruthy();
  const { SAMLResponse } = await minted.json();
  const acs = await request.post(`/api/auth/sso/${slug}/acs`, { form: { SAMLResponse }, maxRedirects: 0 });
  expect(acs.status()).toBe(303);
  // The sign-in itself never depends on the sync.
  expect(acs.headers()['location']).toContain('/auth/sso/complete?token=');
}

async function cleanup(orgId: string, emails: string[]) {
  const users = await prisma.user.findMany({ where: { orgId }, select: { id: true, email: true } });
  await prisma.ssoLoginGrant.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  for (const email of new Set([...emails, ...users.map((u) => u.email)])) await cleanupByEmail(email);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
}

test('SSO directory sync: mapped claims refresh the profile on every sign-in, by the shared overwrite policy', { tag: '@smoke' }, async ({ request }) => {
  const org = await seedOrg('sso-dirsync');
  const adminEmail = uniqueEmail('sso-dirsync-admin').toLowerCase();
  const email = uniqueEmail('sso-dirsync-user').toLowerCase();
  const admin = await adminContext(org.id, adminEmail);
  const api = `/api/admin/organizations/${org.id}/sso-attribute-mappings`;
  try {
    await prisma.orgAttribute.create({
      data: { orgId: org.id, key: 'cost_center', labelEn: 'Cost center', labelTr: 'Masraf yeri', labelDe: 'Kostenstelle', type: 'TEXT' },
    });

    // --- the write boundary: an allowlist, never identity or access ----------
    for (const target of ['department', 'city', 'attr:cost_center']) {
      const created = await admin.post(api, { data: { claim: target === 'attr:cost_center' ? 'costCenter' : target, target } });
      expect(created.status(), target).toBe(201);
    }
    for (const target of ['email', 'role', 'orgId']) {
      const refused = await admin.post(api, { data: { claim: 'x', target } });
      expect(refused.status(), target).toBe(400);
      expect((await refused.json()).code).toBe('invalid_target');
    }
    const unknown = await admin.post(api, { data: { claim: 'x', target: 'attr:not_defined_here' } });
    expect((await unknown.json()).code).toBe('unknown_attribute');
    expect((await admin.post(api, { data: { claim: 'other', target: 'city' } })).status()).toBe(409);

    // --- first sign-in provisions and fills ---------------------------------
    await ssoSignIn(request, org.slug, email, { department: 'Sales', city: 'Berlin', costCenter: 'CC-1' });
    const user = await prisma.user.findFirstOrThrow({ where: { email, orgId: org.id } });
    expect(user.department).toBe('Sales');
    expect(user.city).toBe('Berlin');
    expect(user.ssoLastSyncedAt).toBeTruthy();
    const cc = await prisma.userAttributeValue.findFirst({ where: { userId: user.id } });
    expect(cc?.value).toBe('CC-1');

    // --- not authoritative (the default): a value the person changed stays ---
    await prisma.user.update({ where: { id: user.id }, data: { city: 'Köln', department: null } });
    await ssoSignIn(request, org.slug, email, { department: 'Engineering', city: 'Berlin', costCenter: 'CC-2' });
    let now = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(now.city, 'the person\'s own correction is not reverted').toBe('Köln');
    expect(now.department, 'an empty field is a gap the IdP fills').toBe('Engineering');
    expect((await prisma.userAttributeValue.findFirstOrThrow({ where: { userId: user.id } })).value).toBe('CC-1');

    // --- authoritative: the IdP wins on the next sign-in --------------------
    expect((await admin.patch(api, { data: { authoritative: true } })).status()).toBe(200);
    await ssoSignIn(request, org.slug, email, { department: 'Engineering', city: 'Hamburg', costCenter: 'CC-3' });
    now = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(now.city).toBe('Hamburg');
    expect((await prisma.userAttributeValue.findFirstOrThrow({ where: { userId: user.id } })).value).toBe('CC-3');

    // The audit line names fields, never values.
    const lines = await prisma.activityLog.findMany({ where: { action: 'sso.profile_synced', targetId: user.id } });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      for (const value of ['Sales', 'Berlin', 'Köln', 'Hamburg', 'Engineering', 'CC-']) expect(l.detail ?? '').not.toContain(value);
    }

    // The admin sees when the directory last synced.
    const listed = await (await admin.get(api)).json();
    expect(listed.lastSyncedAt).toBeTruthy();
    expect(listed.mappings).toHaveLength(3);
  } finally {
    await admin.dispose();
    await cleanup(org.id, [adminEmail, email]);
  }
});

test('SSO directory sync: an inline photo is stored as avatar bytes; a photo URL on a private address is refused without refusing the sign-in', { tag: '@smoke' }, async ({ request }) => {
  const org = await seedOrg('sso-dirsync-photo');
  const inlineEmail = uniqueEmail('sso-photo-inline').toLowerCase();
  const ssrfEmail = uniqueEmail('sso-photo-ssrf').toLowerCase();
  try {
    await prisma.ssoAttributeMapping.create({ data: { orgId: org.id, claim: 'thumbnailPhoto', target: 'photo' } });

    await ssoSignIn(request, org.slug, inlineEmail, { thumbnailPhoto: PNG_BASE64 });
    const inline = await prisma.user.findFirstOrThrow({ where: { email: inlineEmail, orgId: org.id } });
    // The photo runs after the response.
    await expect.poll(async () => (await prisma.avatarFile.findUnique({ where: { userId: inline.id } }))?.contentType ?? null, { timeout: 15_000 }).toBe('image/png');
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: inline.id } });
    expect(stored.avatarUrl, 'served by us, never hotlinked').toBe(`/api/avatar/${inline.id}`);

    // Instance metadata on a link-local address: the SSRF guard's refusal.
    await ssoSignIn(request, org.slug, ssrfEmail, { thumbnailPhoto: 'https://169.254.169.254/latest/meta-data/' });
    const ssrf = await prisma.user.findFirstOrThrow({ where: { email: ssrfEmail, orgId: org.id } });
    await expect.poll(async () => (await prisma.user.findUniqueOrThrow({ where: { id: ssrf.id } })).ssoSyncError, { timeout: 15_000 }).toBe('photo_blocked');
    expect(await prisma.avatarFile.count({ where: { userId: ssrf.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ssrf.id } })).avatarUrl).toBeNull();
  } finally {
    await cleanup(org.id, [inlineEmail, ssrfEmail]);
  }
});
