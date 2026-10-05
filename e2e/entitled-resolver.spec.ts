import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// One resolver for paid features (#1733): a company's access comes from its
// ORG — the subscription plan or an unexpired org grant — through
// entitled(orgId, feature). A legacy per-company CompanyEntitlement row still
// grants (grandfathering). No org and no row is a plain 403, never a 500.
//
// Driven through the talent-pool API, the TALENT_POOL_SEARCH gate a COMPANY
// user actually hits, plus the admin grid's payload that names the source.

const PW = 'EntitledPass123!';
const DAY = 24 * 60 * 60 * 1000;

async function companyLogin(page: Page, email: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', PW);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });
}

test.describe('entitled(orgId, feature)', () => {
  const stamp = `${Date.now()}`;
  const orgIds: string[] = [];
  const companyIds: string[] = [];
  const emails: string[] = [];
  const users: Record<string, string> = {};
  let plannedCompanyId = '';
  let adminEmail = '';

  /** A company (optionally in an org) with one COMPANY login; returns the login e-mail. */
  async function company(label: string, orgId: string | null) {
    const c = await prisma.company.create({ data: { name: `Ent ${label} ${stamp}`, ...(orgId ? { orgId } : {}) } });
    companyIds.push(c.id);
    const email = uniqueEmail(`ent-${label}`);
    emails.push(email);
    await prisma.user.create({
      data: { email, password: await bcrypt.hash(PW, 10), role: 'COMPANY', fullName: `Ent ${label}`, companyId: c.id, skills: [], ...(orgId ? { orgId } : {}) },
    });
    return { id: c.id, email };
  }

  async function org(label: string) {
    const o = await prisma.organization.create({ data: { name: `Ent ${label} ${stamp}`, slug: `ent-${label}-${stamp}` } });
    orgIds.push(o.id);
    return o.id;
  }

  test.beforeAll(async () => {
    // On the employer plan: TALENT_POOL_SEARCH comes with the plan.
    const planned = await org('planned');
    await prisma.subscription.create({ data: { orgId: planned, planKey: 'employer', status: 'ACTIVE' } });
    const p = await company('planned', planned);
    plannedCompanyId = p.id;
    users.planned = p.email;
    adminEmail = uniqueEmail('ent-admin');
    emails.push(adminEmail);
    await seedUser(adminEmail, PW, 'ADMIN', 'Ent Admin', planned);

    // A cancelled employer subscription carries no features.
    const cancelled = await org('cancelled');
    await prisma.subscription.create({ data: { orgId: cancelled, planKey: 'employer', status: 'CANCELED' } });
    users.cancelled = (await company('cancelled', cancelled)).email;

    // Free plan: locked — unless the company has a legacy row (grandfathered).
    const free = await org('free');
    await prisma.subscription.create({ data: { orgId: free, planKey: 'employer_free', status: 'ACTIVE' } });
    users.free = (await company('free', free)).email;
    const legacy = await company('legacy', free);
    await prisma.companyEntitlement.create({ data: { companyId: legacy.id, feature: 'TALENT_POOL_SEARCH' } });
    users.legacy = legacy.email;

    // A hand grant to the org, live and expired.
    const granted = await org('granted');
    await prisma.orgEntitlement.create({ data: { orgId: granted, feature: 'TALENT_POOL_SEARCH', expiresAt: new Date(Date.now() + 30 * DAY) } });
    users.granted = (await company('granted', granted)).email;
    const expired = await org('expired');
    await prisma.orgEntitlement.create({ data: { orgId: expired, feature: 'TALENT_POOL_SEARCH', expiresAt: new Date(Date.now() - DAY) } });
    users.expired = (await company('expired', expired)).email;

    // No org at all, no row: fail closed.
    users.orphan = (await company('orphan', null)).email;
  });

  test.afterAll(async () => {
    for (const email of emails) await cleanupByEmail(email);
    await prisma.companyEntitlement.deleteMany({ where: { companyId: { in: companyIds } } });
    await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
    await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.subscription.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  for (const [who, status] of [
    ['planned', 200], // plan includes it, no CompanyEntitlement row anywhere
    ['granted', 200], // unexpired org grant
    ['legacy', 200], // free plan, but a legacy per-company row (grandfathered)
    ['free', 403],
    ['cancelled', 403],
    ['expired', 403],
    ['orphan', 403], // no org, no row: 403, not a 500
  ] as const) {
    test(`talent pool: ${who} → ${status}`, async ({ page }) => {
      await companyLogin(page, users[who]);
      expect((await page.request.get('/api/company/talent-pool')).status()).toBe(status);
    });
  }

  test('the admin grid says the feature comes from the plan, not a company override', async ({ page }) => {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', PW);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    const body = await (await page.request.get(`/api/admin/companies/${plannedCompanyId}/entitlements`)).json();
    expect(body.features.TALENT_POOL_SEARCH).toBe(true);
    expect(body.sources.TALENT_POOL_SEARCH).toEqual({ enabled: true, fromPlan: true, override: false });
    // Not on the employer plan: off, and no override.
    expect(body.sources.EARLY_ACCESS).toEqual({ enabled: false, fromPlan: false, override: false });
    expect(await prisma.companyEntitlement.count({ where: { companyId: plannedCompanyId } })).toBe(0);
  });
});
