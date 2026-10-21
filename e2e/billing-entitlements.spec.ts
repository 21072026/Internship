import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// The included-features tab of /admin/billing and the one write behind it (#1734).
//
// A tenant admin reads its own org's features, each marked plan or override,
// and CANNOT grant one — the route answers 403, checked by calling it directly.
// A super admin of the org's world grants a time-boxed feature; the tenant's
// next read (the same resolver entitled() uses) carries it at once, and a
// revoke takes it away again.

const PW = 'BillingEnt123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('features tab shows plan vs granted; only a super admin may grant', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const tenant = await prisma.organization.create({ data: { name: `Ent Tenant ${stamp}`, slug: `ent-tenant-${stamp}` } });
  await prisma.subscription.create({ data: { orgId: tenant.id, planKey: 'program', interval: 'YEARLY' } });
  const def = await prisma.organization.upsert({
    where: { slug: 'default' },
    update: {},
    create: { slug: 'default', name: 'Default Organization' },
    select: { id: true },
  });
  const emails = { admin: uniqueEmail('ent-tab-admin'), operator: uniqueEmail('ent-tab-operator') };
  await seedUser(emails.admin, PW, 'ADMIN', 'Ent Tab Admin', { orgId: tenant.id });
  const operator = await seedUser(emails.operator, PW, 'ADMIN', 'Ent Tab Operator', { orgId: def.id });
  await prisma.user.update({ where: { id: operator.id }, data: { isSuperAdmin: true } });

  const jars: Awaited<ReturnType<typeof playwright.request.newContext>>[] = [];
  const jar = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL });
    jars.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { headers: freshIp(`ent-${email}`) })).error).toBeNull();
    return ctx;
  };
  const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  try {
    const a = await jar(emails.admin);
    const o = await jar(emails.operator);

    // The tenant's own read: the plan's features, marked `plan`; no grant form.
    let bill = await (await a.get('/api/org/billing')).json();
    expect(bill.canGrant).toBe(false);
    expect(bill.features).toEqual(
      expect.arrayContaining([{ key: 'ADVANCED_ANALYTICS', source: 'plan', expiresAt: null }]),
    );
    expect(bill.features.some((f: { key: string }) => f.key === 'AI_PACKAGE')).toBe(false);

    // A tenant admin cannot grant — not even to its own org.
    const denied = await a.post('/api/admin/billing/entitlements', { data: { orgId: tenant.id, feature: 'AI_PACKAGE', action: 'grant' } });
    expect(denied.status()).toBe(403);
    expect(await prisma.orgEntitlement.count({ where: { orgId: tenant.id } })).toBe(0);

    // The operator grants a time-boxed AI pack; unknown features and past dates are refused.
    expect((await o.post('/api/admin/billing/entitlements', { data: { orgId: tenant.id, feature: 'NOPE', action: 'grant' } })).status()).toBe(400);
    expect(
      (await o.post('/api/admin/billing/entitlements', { data: { orgId: tenant.id, feature: 'AI_PACKAGE', action: 'grant', expiresAt: '2020-01-01T00:00:00.000Z' } })).status(),
    ).toBe(400);
    const grant = await o.post('/api/admin/billing/entitlements', {
      data: { orgId: tenant.id, feature: 'AI_PACKAGE', action: 'grant', note: 'Pilot', expiresAt: until },
    });
    expect(grant.status()).toBe(200);
    expect(await prisma.activityLog.count({ where: { action: 'admin.org_entitlement.grant', targetId: tenant.id } })).toBe(1);

    // At once, in the tenant's next read.
    bill = await (await a.get('/api/org/billing')).json();
    const ai = bill.features.find((f: { key: string }) => f.key === 'AI_PACKAGE');
    expect(ai.source).toBe('override');
    expect(ai.expiresAt).toBe(until);

    // The tab renders it, with one billing request for the whole page.
    expect((await signInViaApi(page.request, emails.admin, PW, { headers: freshIp('ent-ui-admin') })).error).toBeNull();
    let billingCalls = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/org/billing') billingCalls += 1;
    });
    await gotoSettled(page, '/admin/billing');
    await page.getByTestId('billing-tab-features').click();
    await expect(page.getByTestId('billing-feature-source-AI_PACKAGE')).toHaveText('Granted');
    await expect(page.getByTestId('billing-feature-source-ADVANCED_ANALYTICS')).toHaveText('Plan');
    await expect(page.getByTestId('billing-grant-form')).toHaveCount(0);
    expect(billingCalls).toBe(1);

    // Revoked: gone from the next read.
    expect((await o.post('/api/admin/billing/entitlements', { data: { orgId: tenant.id, feature: 'AI_PACKAGE', action: 'revoke' } })).status()).toBe(200);
    bill = await (await a.get('/api/org/billing')).json();
    expect(bill.features.some((f: { key: string }) => f.key === 'AI_PACKAGE')).toBe(false);

    // The operator sees the grant form on its own billing screen.
    expect((await signInViaApi(page.request, emails.operator, PW, { headers: freshIp('ent-ui-operator') })).error).toBeNull();
    await gotoSettled(page, '/admin/billing');
    await page.getByTestId('billing-tab-features').click();
    await expect(page.getByTestId('billing-grant-form')).toBeVisible();
  } finally {
    for (const ctx of jars) await ctx.dispose();
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.activityLog.deleteMany({ where: { targetId: tenant.id } });
    await prisma.organization.delete({ where: { id: tenant.id } }).catch(() => {});
  }
});
