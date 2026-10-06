import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// The programme health scorecard (#1908). Its own org, so the match rate is
// exactly the participants seeded here — and it sits ON the green line:
// 4 of 5 active participants matched = 80 % = GREEN (the threshold is
// inclusive). One more unmatched participant tips it to 67 % = AMBER, and the
// row grows a link to where matching is done.

const PW = 'Scorecard123!';

test.describe('programme health scorecard', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('sc-admin');
  const mentor = uniqueEmail('sc-mentor');
  const mentees = [1, 2, 3, 4, 5, 6].map((n) => uniqueEmail(`sc-mentee-${n}`));
  let orgId = '';
  let sixthId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `SC Org ${stamp}`, slug: `sc-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `SC Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `SC Mentor ${stamp}`, orgId);
    const ids: string[] = [];
    for (const [i, email] of mentees.entries()) ids.push((await seedUser(email, PW, 'MENTEE', `SC Mentee ${i} ${stamp}`, orgId)).id);
    for (const id of ids.slice(0, 4)) {
      await prisma.mentorshipRelation.create({ data: { orgId, mentorId: m.id, menteeId: id, pipelineStatus: 'INTERVIEW_PENDING_250' } });
    }
    // The sixth starts deactivated — not an active participant, not counted.
    sixthId = ids[5];
    await prisma.user.update({ where: { id: sixthId }, data: { isActive: false } });
  });

  test.afterAll(async () => {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.orgEntitlement.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('a band at the threshold boundary, a link when it slips, and honest gaps', { tag: '@smoke' }, async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');

    const before = (await (await page.request.get('/api/admin/analytics/scorecard')).json()).rows;
    const row = (rows: { key: string }[], key: string) => rows.find((r) => r.key === key);
    expect(row(before, 'matchRate')).toMatchObject({ status: 'ok', value: 80, basis: 5, band: 'GREEN', target: 80, nextAction: null });
    // Four relationships are below the five a ratio needs to be judged.
    expect(row(before, 'stalledPairs')).toMatchObject({ status: 'insufficient', basis: 0 });
    expect(row(before, 'atRisk')).toMatchObject({ status: 'insufficient', basis: 4 });
    expect(row(before, 'nps')).toEqual({ key: 'nps', status: 'not_measurable', dependsOn: [1910] });

    await page.goto('/admin/analytics');
    await expect(page.getByTestId('scorecard-band-matchRate')).toHaveAttribute('data-band', 'GREEN');
    await expect(page.getByTestId('scorecard-value-matchRate')).toHaveText('80%');
    await expect(page.getByTestId('scorecard-action-matchRate')).toHaveCount(0);
    await expect(page.getByTestId('scorecard-value-nps')).toHaveText('Not yet measurable');
    await expect(page.getByTestId('scorecard-value-atRisk')).toHaveText('Not enough data yet');

    // One unmatched participant more: 4 / 6 = 67 % — below 80, at or above 60.
    await prisma.user.update({ where: { id: sixthId }, data: { isActive: true } });
    await page.reload();
    await expect(page.getByTestId('scorecard-band-matchRate')).toHaveAttribute('data-band', 'AMBER');
    await expect(page.getByTestId('scorecard-value-matchRate')).toHaveText('67%');
    await expect(page.getByTestId('scorecard-action-matchRate')).toHaveAttribute('href', '/admin/mentorship');
    await prisma.user.update({ where: { id: sixthId }, data: { isActive: false } });
  });

  test('the scorecard reaches the print report and leads the XLSX export', async ({ page }) => {
    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
    await setOrgFeature(orgId, 'REPORT_EXPORT', true);
    await signInAndSettle(page, admin, PW, '/admin');
    await page.goto('/admin/analytics/report');
    await expect(page.getByTestId('full-report').getByTestId('program-scorecard')).toBeVisible();
    await expect(page.getByTestId('scorecard-value-matchRate')).toHaveText('80%');

    const xlsx = await (await page.request.get('/api/admin/export/analytics')).json();
    expect(xlsx.sheets[0].name).toBe('Programme health');
    expect(xlsx.sheets[0].rows.find((r: string[]) => r[0] === 'Participants matched')).toEqual(['Participants matched', '80%', '≥ 80%', 'On track', 5]);
  });

  test('ADMIN only, checked in the handler', async ({ page }) => {
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/analytics/scorecard')).status()).toBe(403);
    await signInAsFreshUser(page, mentees[0], PW, '/portal');
    expect((await page.request.get('/api/admin/analytics/scorecard')).status()).toBe(403);
  });
});
