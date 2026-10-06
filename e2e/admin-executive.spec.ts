import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// /admin/analytics/executive (#1895). Its own org; the window is the last 30
// days and the previous period the 30 before it:
//   R1 active   — contact 5 days ago, moved APPLICATION → INTERVIEW 10 days ago
//   R2 active   — last contact 50 days ago (the previous period), never moved
//   R3 completed 3 days ago — first reached HIRED 8 days ago
//   R4 completed 45 days ago — active only in the previous period
// Now:      3 active → engagement 1/3 = 33, progression 2/3 = 67, placement 1/3 = 33
// Before:   4 active → engagement 1/4 = 25  (so "8 points above")

const PW = 'AdminExec123!';
const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

test.describe('executive dashboard', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('exec-admin');
  const lockedAdmin = uniqueEmail('exec-locked-admin');
  const mentor = uniqueEmail('exec-mentor');
  const mentees = [1, 2, 3, 4].map((n) => uniqueEmail(`exec-mentee-${n}`));
  let orgId = '';
  let lockedOrgId = '';
  const to = iso(new Date());
  const from = iso(new Date(Date.now() - 29 * DAY));

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `Exec Org ${stamp}`, slug: `exec-${stamp}` } })).id;
    lockedOrgId = (await prisma.organization.create({ data: { name: `Exec Locked ${stamp}`, slug: `exec-locked-${stamp}` } })).id;
    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
    await seedUser(admin, PW, 'ADMIN', `Exec Admin ${stamp}`, orgId);
    await seedUser(lockedAdmin, PW, 'ADMIN', `Exec Locked Admin ${stamp}`, lockedOrgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `Exec Mentor ${stamp}`, orgId);
    const e = await Promise.all(mentees.map((email, i) => seedUser(email, PW, 'MENTEE', `Exec Mentee ${i} ${stamp}`, orgId)));
    const ago = (d: number) => new Date(Date.now() - d * DAY);
    const rel = (i: number, data: Record<string, unknown>) =>
      prisma.mentorshipRelation.create({ data: { orgId, mentorId: m.id, menteeId: e[i].id, startDate: ago(200), ...data } });

    const r1 = await rel(0, { pipelineStatus: 'INTERVIEW_PENDING_250' });
    const r2 = await rel(1, { pipelineStatus: 'APPLICATION_100' });
    const r3 = await rel(2, { pipelineStatus: 'HIRED_660', status: 'COMPLETED', completedAt: ago(3) });
    await rel(3, { pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450', status: 'COMPLETED', completedAt: ago(45) });
    await prisma.interactionLog.createMany({
      data: [
        { relationId: r1.id, date: ago(5), notes: 'Check-in', type: 'Call' },
        { relationId: r2.id, date: ago(50), notes: 'Check-in', type: 'Call' },
      ],
    });
    await prisma.statusChange.createMany({
      data: [
        { relationId: r1.id, fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', createdAt: ago(10) },
        { relationId: r3.id, fromStatus: 'INTERNSHIP_COMPLETED_490', toStatus: 'HIRED_660', createdAt: ago(8) },
      ],
    });
  });

  test.afterAll(async () => {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, lockedAdmin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: [orgId, lockedOrgId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, lockedOrgId] } } });
    await prisma.$disconnect();
  });

  test('four named scores, each with its arithmetic, and an honest capability panel', { tag: '@smoke' }, async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');

    const api = await (await page.request.get(`/api/admin/analytics/executive?from=${from}&to=${to}`)).json();
    const now = (k: string) => api[k].at(-1);
    expect(now('engagement')).toMatchObject({ numerator: 1, denominator: 3, score: 33 });
    expect(now('progression')).toMatchObject({ numerator: 2, denominator: 3, score: 67 });
    expect(now('placement')).toMatchObject({ numerator: 1, denominator: 3, score: 33 });
    expect(api.engagement.at(-2)).toMatchObject({ numerator: 1, denominator: 4, score: 25 });
    expect(api.engagement).toHaveLength(6);
    expect(api.capability).toEqual({ measurable: false, dependsOn: [1822, 1823] });

    await page.goto('/admin/analytics/executive');
    await page.getByTestId('executive-from').fill(from);
    await expect(page.getByTestId('executive-engagement-score')).toHaveText('33');
    await expect(page.getByTestId('executive-progression-score')).toHaveText('67');
    await expect(page.getByTestId('executive-placement-score')).toHaveText('33');
    await expect(page.getByTestId('executive-engagement-delta')).toHaveText('Engagement is 8 points above the previous period.');
    await expect(page.getByTestId('executive-engagement-trend').locator('div')).toHaveCount(6);
    await page.getByTestId('executive-engagement-how').click();
    await expect(page.getByTestId('executive-engagement-expression')).toHaveText('100 × 1 ÷ 3 = 33');
    await expect(page.getByTestId('executive-capability-state')).toHaveText('Not yet measurable');
    // The page says, in words, that no score is a prediction.
    await expect(page.getByTestId('executive-deterministic')).toContainText('No score here is predicted');
  });

  test('prints to one A4 page in EN, TR and DE', async ({ page, browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', 'page.pdf() is Chromium-only');
    await signInAndSettle(page, admin, PW, '/admin');
    for (const locale of ['en', 'tr', 'de']) {
      await page.context().addCookies([{ name: 'locale', value: locale, url: baseURL! }]);
      await page.goto('/admin/analytics/executive');
      await expect(page.getByTestId('executive-capability')).toBeVisible();
      await expect(page.getByTestId('executive-engagement-score')).not.toHaveText('');
      const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
      expect(pages, `${locale} prints on ${pages} page(s)`).toBe(1);
    }
  });

  test('locked without ADVANCED_ANALYTICS, and ADMIN-only — at the API', async ({ page }) => {
    await signInAndSettle(page, lockedAdmin, PW, '/admin');
    const res = await page.request.get('/api/admin/analytics/executive');
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' });
    await page.goto('/admin/analytics/executive');
    await expect(page.getByTestId('executive-locked')).toBeVisible();

    await signInAsFreshUser(page, mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/analytics/executive')).status()).toBe(403);
  });
});
