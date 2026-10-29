import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
// Static imports (see retention-prune.spec.ts): Playwright resolves the alias
// when it transforms the spec, Node at runtime does not.
import { activeMatchedPairs, currentPeriod } from '../src/lib/metering';
import { runUsageRollup } from '../src/lib/jobs/usageRollup';

// GET /api/org/usage and the usage tab of /admin/billing (#1763).
//
//  1. The org is the session's: no parameter moves the answer to another
//     tenant, and a non-admin is refused.
//  2. The numbers are the nightly ledger's — after a rollup the active-pair
//     row equals activeMatchedPairs() AND the plan tab's number, to the row;
//     companies and programmes are rolled up too.
//  3. An unlimited limit renders as unlimited, an over-limit row as over, and
//     video is reported, never limited.

const PW = 'OrgUsage123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('usage: own org only, the ledger\'s numbers, the plan tab\'s pair count', { tag: '@smoke' }, async ({ page, playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `Usage A ${stamp}`, slug: `usage-a-${stamp}` } });
  const orgB = await prisma.organization.create({ data: { name: `Usage B ${stamp}`, slug: `usage-b-${stamp}` } });
  await prisma.subscription.create({ data: { orgId: orgB.id, planKey: 'enterprise', interval: 'YEARLY' } });
  const emails = { adminA: uniqueEmail('usage-admin-a'), adminB: uniqueEmail('usage-admin-b'), mentor: uniqueEmail('usage-mentor') };
  await seedUser(emails.adminA, PW, 'ADMIN', 'Usage Admin A', { orgId: orgA.id });
  await seedUser(emails.adminB, PW, 'ADMIN', 'Usage Admin B', { orgId: orgB.id });
  await seedUser(emails.mentor, PW, 'MENTOR', 'Usage Mentor', { orgId: orgA.id });

  // Org A (Community, 3 companies included): three companies — at the limit,
  // so "approaching", not over — and one cohort, rolled up for real.
  await prisma.company.createMany({ data: [1, 2, 3].map((n) => ({ name: `Acme Usage ${n} ${stamp}`, orgId: orgA.id })) });
  const cohort = await prisma.cohort.create({ data: { name: `Usage Cohort ${stamp}`, orgId: orgA.id } });
  await runUsageRollup({ orgIds: [orgA.id] });
  const period = currentPeriod();
  // A counter the rollup never touches, and an over-band pair count for org B.
  await prisma.usageRollup.create({ data: { orgId: orgA.id, metric: 'VIDEO_ROOM', period, value: 40 } });
  await prisma.usageRollup.createMany({
    data: [
      { orgId: orgB.id, metric: 'ACTIVE_MATCHED_PAIRS', period, value: 5000 },
      { orgId: orgB.id, metric: 'COMPANIES', period, value: 900 },
    ],
  });

  const jars: Awaited<ReturnType<typeof playwright.request.newContext>>[] = [];
  const jar = async (email: string) => {
    const ctx = await playwright.request.newContext({ baseURL });
    jars.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { headers: freshIp(`usage-${email}`) })).error).toBeNull();
    return ctx;
  };
  const row = (body: { rows: { key: string }[] }, key: string) => body.rows.find((r) => r.key === key) as {
    key: string; value: number | null; limit: number | null; state: string; history: { period: string; value: number | null }[];
  };

  try {
    const a = await jar(emails.adminA);
    const expectedPairs = await activeMatchedPairs(orgA.id, period);
    const billing = await (await a.get('/api/org/billing')).json();
    for (const q of ['', `?orgId=${orgB.id}`, `?org=${orgB.slug}`]) {
      const res = await a.get(`/api/org/usage${q}`);
      expect(res.status(), q).toBe(200);
      const body = await res.json();
      expect(body.period).toBe(period);
      expect(body.plan.key, q).toBe('community');
      const pairs = row(body, 'activePairs');
      expect(pairs.value, q).toBe(expectedPairs);
      expect(pairs.value, q).toBe(billing.currentPeriod.activePairs);
      expect(pairs.limit).toBe(25);
      expect(pairs.history).toHaveLength(4);
      expect(pairs.history[3].period).toBe(period);
      expect(row(body, 'companies').value, q).toBe(3);
      expect(row(body, 'companies').limit).toBe(3);
      expect(row(body, 'companies').state).toBe('approaching');
      expect(row(body, 'programs').value).toBe(1);
      expect(row(body, 'adminSeats').value).toBe(1);
      expect(row(body, 'videoRooms').value).toBe(40);
      expect(row(body, 'videoRooms').state).toBe('reported');
      expect(row(body, 'aiCalls').state).toBe('not_included');
    }

    // Org B (Enterprise): unlimited is unlimited, however large the number.
    const b = await jar(emails.adminB);
    const bBody = await (await b.get(`/api/org/usage?orgId=${orgA.id}`)).json();
    expect(row(bBody, 'activePairs').value).toBe(5000);
    expect(row(bBody, 'activePairs').limit).toBeNull();
    expect(row(bBody, 'activePairs').state).toBe('unlimited');
    expect(row(bBody, 'companies').state).toBe('unlimited');
    expect(bBody.anyOver).toBe(false);

    // A mentor has no bill to read; signed out is 401.
    expect((await (await jar(emails.mentor)).get('/api/org/usage')).status()).toBe(403);
    const anon = await playwright.request.newContext({ baseURL });
    jars.push(anon);
    expect((await anon.get('/api/org/usage')).status()).toBe(401);

    // The tab: org A's rows, the definition and the never-metered statement.
    expect((await signInViaApi(page.request, emails.adminA, PW, { headers: freshIp('usage-ui-a') })).error).toBeNull();
    await gotoSettled(page, '/admin/billing');
    await page.getByTestId('billing-tab-usage').click();
    await expect(page.getByTestId('usage-value-companies')).toHaveText('3', { timeout: 20_000 });
    await expect(page.getByTestId('usage-limit-companies')).toContainText('3');
    await expect(page.getByTestId('usage-row-companies')).toHaveAttribute('data-state', 'approaching');
    await expect(page.getByTestId('usage-value-activePairs')).toHaveText(String(expectedPairs));
    await expect(page.getByTestId('usage-state-videoRooms')).toHaveText('Reported, never limited');
    await expect(page.getByTestId('usage-pair-definition')).toContainText('paused, benched and completed pairs are not counted');
    await expect(page.getByTestId('usage-never-metered')).toContainText('Mentors, mentees and programmes are never counted');
    await expect(page.getByTestId('usage-trend-activePairs')).toBeVisible();
  } finally {
    for (const ctx of jars) await ctx.dispose();
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.usageRollup.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.subscription.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.company.deleteMany({ where: { orgId: orgA.id } });
    await prisma.cohort.deleteMany({ where: { id: cohort.id } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
