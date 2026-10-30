import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, setOrgFeature, uniqueEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';

// Admin oversight of self-served credentials (#2006): every key and hook a
// COMPANY or SOURCE owner minted under the org is on the admin's integrations
// screen, labelled with whose it is; an org-wide one carries no label.

const PW = 'OwnerLabel123!';
let orgId = '';
const admin = uniqueEmail('olabel-admin');

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `OLabel ${stamp}`, slug: `olabel-${stamp}` } })).id;
  await setOrgFeature(orgId, 'INTEGRATIONS_API', true);
  await seedUser(admin, PW, 'ADMIN', 'OLabel Admin', orgId);
});

test.afterAll(async () => {
  if (!orgId) return;
  await prisma.webhook.deleteMany({ where: { orgId } });
  await prisma.apiKey.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.company.deleteMany({ where: { orgId } });
  await prisma.source.deleteMany({ where: { orgId } });
  await prisma.orgEntitlement.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

test('the admin sees which company or source a self-served key or hook belongs to', async ({ page }) => {
  const company = await prisma.company.create({ data: { orgId, name: 'Acme Hiring' } });
  const source = await prisma.source.create({ data: { orgId, name: 'Example Academy' } });
  const in30 = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const mkKey = (name: string, extra: object) =>
    prisma.apiKey.create({ data: { orgId, name, hashedKey: randomBytes(32).toString('hex'), scopes: 'candidates:read', expiresAt: in30, ...extra } });
  const [companyKey, sourceKey, orgKey] = await Promise.all([
    mkKey('Company key', { companyId: company.id, scopes: 'hiring:read' }),
    mkKey('Source key', { sourceId: source.id }),
    mkKey('Org key', {}),
  ]);
  const sourceHook = await prisma.webhook.create({ data: { orgId, sourceId: source.id, source: 'source', url: 'https://93.184.215.14/olabel', secret: 's', events: ['user.created'] } });

  expect((await signInViaApi(page.request, admin, PW)).ok).toBe(true);
  await gotoSettled(page, '/admin/integrations');
  await expect(page.getByTestId(`api-key-scope-owner-${companyKey.id}`)).toContainText('Acme Hiring');
  await expect(page.getByTestId(`api-key-scope-owner-${sourceKey.id}`)).toContainText('Example Academy');
  await expect(page.getByTestId(`api-key-scope-owner-${orgKey.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`webhook-scope-owner-${sourceHook.id}`)).toContainText('Example Academy');
});
