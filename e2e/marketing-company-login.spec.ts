import { test, expect, type Page } from '@playwright/test';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser } from './helpers/auth';
import { putOnWorld, seedTwoTenants, signInAsTenantActor, type TwoTenants } from './helpers/tenants';

/**
 * No company portal in MARKETING (#2348, MKT-2) — a security boundary.
 *
 * In an INTERNSHIP tenant a COMPANY login is a hiring partner and `/company`
 * is its portal. In a MARKETING tenant a company is the CUSTOMER, and the
 * portal would read the tenant's funnel — every lead at that company, its
 * owner and its stage. So in a vertical without `placements`:
 *
 *   - no COMPANY login can be created (POST /api/admin/company-users → 403);
 *   - a COMPANY login that already exists never renders `/company` (it lands
 *     on `/account`, the role-neutral terminal page);
 *   - /api/mentorship answers it an EMPTY list (not a 403: shared components
 *     a COMPANY session can mount call it), and /api/companies/<own> carries
 *     no relations;
 *   - every /api/company/* route it could still call refuses it.
 *
 * Tenant A is MARKETING, tenant B is INTERNSHIP: B's company login is the
 * control that the same calls still work where the portal exists.
 */

let tenants: TwoTenants;

test.beforeAll(async () => {
  tenants = await seedTwoTenants({ verticalA: 'MARKETING', verticalB: 'INTERNSHIP' });
});

test.afterAll(async () => {
  await tenants?.cleanup();
  await prisma.$disconnect();
});

async function signInMarketingCompany(page: Page): Promise<void> {
  const actor = tenants.orgA.companyUser;
  await putOnWorld(page, 'MARKETING');
  // roleHome('COMPANY') is '/company'; the layout sends this login on to '/account'.
  await signInAsFreshUser(page, actor.email, actor.password, '/account');
}

test('a MARKETING admin cannot create a company login; the card is not offered', { tag: '@smoke' }, async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgA.admin);
  const email = uniqueEmail('mkt-company-login');
  const res = await page.request.post('/api/admin/company-users', {
    data: { companyId: tenants.orgA.company.id, email, fullName: 'Should Not Exist' },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toMatchObject({ code: 'capability_missing' });
  expect(await prisma.user.count({ where: { email } })).toBe(0);

  // The provisioning card is not offered (the companies list itself renders).
  await gotoSettled(page, '/admin/companies');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('company-login-card')).toHaveCount(0);

  // The admin opening /company goes to its own shell, not the portal.
  await page.goto('/company');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'));
});

test('an existing MARKETING company login never renders /company', { tag: '@smoke' }, async ({ page }) => {
  await signInMarketingCompany(page);
  await page.goto('/company');
  await page.waitForURL((u) => u.pathname.startsWith('/account'));
  expect(new URL(page.url()).pathname).not.toMatch(/^\/company/);
});

test('a MARKETING company login reads no funnel and is refused by the company API', { tag: '@smoke' }, async ({ page }) => {
  await signInMarketingCompany(page);

  // The funnel: an empty list, in both the plain and the paged shape.
  const plain = await page.request.get('/api/mentorship');
  expect(plain.status()).toBe(200);
  expect((await plain.json()).relations).toEqual([]);
  const paged = await page.request.get('/api/mentorship?pageSize=100');
  expect(paged.status()).toBe(200);
  expect(await paged.json()).toMatchObject({ relations: [], total: 0 });

  // Its own company, without the relations hanging off it.
  const own = await page.request.get(`/api/companies/${tenants.orgA.company.id}`);
  expect(own.status()).toBe(200);
  const ownBody = await own.json();
  expect(ownBody.company.id).toBe(tenants.orgA.company.id);
  expect(ownBody.company.mentorships).toEqual([]);
  expect(JSON.stringify(ownBody)).not.toContain(tenants.orgA.mentee.id);

  const refused: Array<[string, () => ReturnType<Page['request']['get']>]> = [
    ['GET /api/company/talent-pool', () => page.request.get('/api/company/talent-pool')],
    ['GET /api/company/analytics', () => page.request.get('/api/company/analytics')],
    ['GET /api/company/analytics/benchmark', () => page.request.get('/api/company/analytics/benchmark')],
    ['GET /api/company/candidates/<id>', () => page.request.get(`/api/company/candidates/${tenants.orgA.mentee.id}`)],
    ['GET /api/company/onboarding', () => page.request.get('/api/company/onboarding')],
    ['POST /api/company/onboarding/domain-proof', () => page.request.post('/api/company/onboarding/domain-proof', { data: {} })],
    ['GET /api/company/integrations/api-keys', () => page.request.get('/api/company/integrations/api-keys')],
    ['GET /api/company/integrations/webhooks', () => page.request.get('/api/company/integrations/webhooks')],
    ['PATCH /api/company/outreach/<id>', () => page.request.patch('/api/company/outreach/does-not-exist', { data: { action: 'approve' } })],
  ];
  for (const [name, call] of refused) {
    const res = await call();
    expect(res.status(), name).toBe(403);
    expect(await res.json(), name).toMatchObject({ code: 'capability_unavailable', capability: 'placements' });
  }
});

test('control: an INTERNSHIP admin still gets the company-login card', { tag: '@smoke' }, async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgB.admin);
  await gotoSettled(page, '/admin/companies');
  await expect(page.getByTestId('company-login-card')).toBeVisible();
});

test('control: an INTERNSHIP company login keeps its portal and its relations', { tag: '@smoke' }, async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgB.companyUser);
  expect(new URL(page.url()).pathname).toMatch(/^\/company/);
  const res = await page.request.get('/api/mentorship');
  expect(res.status()).toBe(200);
  const ids = ((await res.json()).relations as Array<{ id: string }>).map((r) => r.id);
  expect(ids).toContain(tenants.orgB.relation.id);
  const own = await page.request.get(`/api/companies/${tenants.orgB.company.id}`);
  expect(((await own.json()).company.mentorships as Array<{ id: string }>).map((r) => r.id)).toContain(tenants.orgB.relation.id);
});
