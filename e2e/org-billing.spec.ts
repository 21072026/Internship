import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

// GET /api/org/billing answers for the CALLER'S org only (#1739).
//
// Two INTERNSHIP tenants on one database, each with its own UsageRollup rows for
// this month. Each admin reads its own number, and no parameter — `orgId`,
// `org`, a slug — moves the answer to the other tenant: the route takes none,
// the org is the session's. Every non-ADMIN role is refused by the handler
// itself, and a MARKETING admin (no `mentorship` capability: the meter and the
// price list are the internship product's) is refused the same way.

const PW = 'OrgBilling123!';

function utcPeriod(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('each admin reads only its own org\'s bill; other roles and verticals are refused', { tag: '@smoke' }, async ({
  page,
  playwright,
  baseURL,
}) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `Billing A ${stamp}`, slug: `billing-a-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Billing B ${stamp}`, slug: `billing-b-${stamp}` } });
  const mkt = await prisma.organization.create({
    data: { name: `Billing MKT ${stamp}`, slug: `billing-mkt-${stamp}`, vertical: 'MARKETING' },
  });
  await prisma.subscription.create({ data: { orgId: orgB.id, planKey: 'program_plus', interval: 'YEARLY' } });

  const period = utcPeriod();
  await prisma.usageRollup.createMany({
    data: [
      { orgId: orgA.id, metric: 'ACTIVE_MATCHED_PAIRS', period, value: 11 },
      { orgId: orgA.id, metric: 'ADMIN_SEATS', period, value: 2 },
      { orgId: orgB.id, metric: 'ACTIVE_MATCHED_PAIRS', period, value: 77 },
      { orgId: orgB.id, metric: 'ADMIN_SEATS', period, value: 9 },
    ],
  });

  const emails = {
    adminA: uniqueEmail('billing-admin-a'),
    adminB: uniqueEmail('billing-admin-b'),
    adminMkt: uniqueEmail('billing-admin-mkt'),
    MENTOR: uniqueEmail('billing-mentor'),
    MENTEE: uniqueEmail('billing-mentee'),
    COMPANY: uniqueEmail('billing-company'),
    SOURCE: uniqueEmail('billing-source'),
  };
  await seedUser(emails.adminA, PW, 'ADMIN', 'Billing Admin A', { orgId: orgA.id });
  await seedUser(emails.adminB, PW, 'ADMIN', 'Billing Admin B', { orgId: orgB.id });
  await seedUser(emails.adminMkt, PW, 'ADMIN', 'Billing Admin MKT', { orgId: mkt.id });
  for (const role of ['MENTOR', 'MENTEE', 'COMPANY', 'SOURCE'] as const) {
    await seedUser(emails[role], PW, role, `Billing ${role}`, { orgId: orgA.id });
  }

  const jars: Awaited<ReturnType<typeof playwright.request.newContext>>[] = [];
  const jar = async (email: string, host?: string) => {
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: host ? asHost(host) : {} });
    jars.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { host, headers: freshIp(`billing-${email}`) })).error).toBeNull();
    return ctx;
  };

  try {
    // 1. Org A's admin: its own number, whatever it appends to the URL.
    const a = await jar(emails.adminA);
    for (const q of ['', `?orgId=${orgB.id}`, `?org=${orgB.slug}`, `?orgSlug=${orgB.slug}`]) {
      const res = await a.get(`/api/org/billing${q}`);
      expect(res.status(), q).toBe(200);
      const body = await res.json();
      expect(body.currentPeriod.period).toBe(period);
      expect(body.currentPeriod.activePairs, q).toBe(11);
      expect(body.currentPeriod.adminSeats, q).toBe(2);
      expect(body.plan.key).toBe('community');
      expect(body.history).toHaveLength(12);
    }

    // 2. Org B's admin: its own plan and number.
    const b = await jar(emails.adminB);
    const bBody = await (await b.get(`/api/org/billing?orgId=${orgA.id}`)).json();
    expect(bBody.currentPeriod.activePairs).toBe(77);
    expect(bBody.plan.key).toBe('program_plus');
    expect(bBody.billingCycle).toBe('YEARLY');

    // 3. Every non-ADMIN role is refused by the handler.
    for (const role of ['MENTOR', 'MENTEE', 'COMPANY', 'SOURCE'] as const) {
      const r = await jar(emails[role]);
      expect((await r.get('/api/org/billing')).status(), role).toBe(403);
    }

    // 4. A MARKETING admin: no `mentorship` capability, no internship meter.
    const m = await jar(emails.adminMkt, MARKETING_HOST);
    const mRes = await m.get('/api/org/billing');
    expect(mRes.status()).toBe(403);
    expect((await mRes.json()).code).toBe('capability_unavailable');

    // 5. The screen shows org A's own number and the free-core promise.
    expect((await signInViaApi(page.request, emails.adminA, PW, { headers: freshIp('billing-ui-a') })).error).toBeNull();
    await gotoSettled(page, '/admin/billing');
    await expect(page.getByTestId('billing-active-pairs')).toHaveText('11');
    await expect(page.getByTestId('billing-plan-name')).toHaveText('Community');
    await expect(page.getByTestId('billing-free-core')).toBeVisible();
    await expect(page.getByTestId(`billing-history-${period}`)).toContainText('11');

    // 6. The definition next to the number links to the sentence /pricing
    //    publishes (#1735), and the two say the same thing.
    const defLink = page.getByTestId('billing-meter-definition-link');
    await expect(defLink).toHaveAttribute('href', '/pricing#how-we-count');
    await defLink.click();
    await expect(page).toHaveURL(/\/pricing#how-we-count$/);
    const published = page.locator('#how-we-count');
    await expect(published).toBeVisible({ timeout: 20_000 });
    await expect(published).toContainText('ACTIVE state with any logged activity during the calendar month');
    await expect(published).toContainText('paused, benched and completed pairs');
  } finally {
    for (const ctx of jars) await ctx.dispose();
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.usageRollup.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.subscription.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id, mkt.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id, mkt.id] } } });
  }
});
