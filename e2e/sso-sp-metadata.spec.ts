import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * The SP metadata endpoint (#1931).
 *
 * Everything here goes through `page.request` on purpose: the document is what a
 * customer's identity team fetches with curl or pastes into their IdP's import
 * box, so the contract that matters is the HTTP one — public, pre-auth, correct
 * content type, and served *before* SSO is switched on, which is exactly when
 * configuration happens. The admin panel is asserted through the same API that
 * feeds it, rather than by driving the SSO form, so a layout change cannot make
 * this spec lie about whether the identifiers are published.
 */

const PASSWORD = 'SpMeta123!';

let slug: string;
let orgId: string;
let adminEmail: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  slug = `spmeta-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { slug, name: 'SP Metadata Org' } });
  orgId = org.id;
  adminEmail = uniqueEmail('spmeta-admin');
  const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'SP Metadata Admin');
  await prisma.user.update({ where: { id: admin.id }, data: { orgId } });
});

test.afterAll(async () => {
  if (adminEmail) await cleanupByEmail(adminEmail);
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the metadata document is public, well-formed and names our ACS URL', async ({ request }) => {
  // ssoEnabled is still false on the seeded org: metadata must be served while
  // the tenant is being configured, not only after it goes live.
  const res = await request.get(`/api/auth/sso/${slug}/metadata`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('samlmetadata+xml');

  const xml = await res.text();
  expect(xml).toContain('<md:EntityDescriptor');
  expect(xml).toContain(`/sso/${slug}"`);
  expect(xml).toContain(`/api/auth/sso/${slug}/acs`);
  expect(xml).toContain('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
  // The claim the IdP acts on: we require signed assertions.
  expect(xml).toContain('WantAssertionsSigned="true"');
  // NameIDFormat must precede AssertionConsumerService or a strict validator
  // rejects the document.
  expect(xml.indexOf('NameIDFormat')).toBeLessThan(xml.indexOf('AssertionConsumerService'));
});

test('an unknown tenant slug is a 404, not an empty document', async ({ request }) => {
  const res = await request.get(`/api/auth/sso/${slug}-nope/metadata`);
  expect(res.status()).toBe(404);
});

test('the admin organizations API publishes the three SP identifiers', async ({ page }) => {
  await signInAndSettle(page, adminEmail, PASSWORD, '/admin');
  const res = await page.request.get('/api/admin/organizations');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const org = (body.organizations as { slug: string; sso: Record<string, string> }[]).find(
    (o) => o.slug === slug
  );
  expect(org).toBeTruthy();
  expect(org!.sso.spEntityId).toContain(`/sso/${slug}`);
  expect(org!.sso.acsUrl).toContain(`/api/auth/sso/${slug}/acs`);
  expect(org!.sso.metadataUrl).toContain(`/api/auth/sso/${slug}/metadata`);
});
