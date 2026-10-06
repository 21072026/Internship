import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { createSurvey, submitSurveyResponse, mintSurveyToken } from '../src/lib/surveys';

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
    await prisma.survey.deleteMany({ where: { orgId } });
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
    expect(row(before, 'evaluationCoverage')).toEqual({ key: 'evaluationCoverage', status: 'not_measurable', dependsOn: [1891] });
    // No survey answers yet: not enough data — never a 0, and no longer "not measurable" (#1910).
    expect(row(before, 'nps')).toMatchObject({ status: 'insufficient', basis: 0 });

    await page.goto('/admin/analytics');
    await expect(page.getByTestId('scorecard-band-matchRate')).toHaveAttribute('data-band', 'GREEN');
    await expect(page.getByTestId('scorecard-value-matchRate')).toHaveText('80%');
    await expect(page.getByTestId('scorecard-action-matchRate')).toHaveCount(0);
    await expect(page.getByTestId('scorecard-value-evaluationCoverage')).toHaveText('Not yet measurable');
    await expect(page.getByTestId('scorecard-value-nps')).toHaveText('Not enough data yet');
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

  test('survey answers make NPS and the response rate measurable — on screen, in the report and in the XLSX', async ({ page }) => {
    const survey = await createSurvey(orgId, {
      key: 'pulse',
      title: { en: `Programme pulse ${stamp}` },
      audience: 'MENTEE',
      anonymity: 'ANONYMOUS',
      questions: [{ key: 'nps', type: 'NPS', labels: { en: 'Would you recommend us?' }, required: true }],
    });
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
    // 3 promoters, 1 passive, 2 detractors of 6 → round(1/6 · 100) = 17 → AMBER (0 ≤ 17 < 30).
    for (const nps of [10, 10, 9, 7, 3, 2]) await submitSurveyResponse({ surveyId: survey.id, respondentRole: 'MENTEE', answers: { nps } });
    // Ten invitations sent ten days ago, five answered → 50 % → GREEN (the line is inclusive).
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 10; i++) {
      await prisma.surveyInvitation.create({
        data: { orgId, surveyId: survey.id, email: `sc-inv-${i}-${stamp}@example.test`, tokenHash: mintSurveyToken().tokenHash, expiresAt: new Date(Date.now() + 20 * 86400000), createdAt: tenDaysAgo, respondedAt: i < 5 ? new Date() : null },
      });
    }

    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
    await setOrgFeature(orgId, 'REPORT_EXPORT', true);
    await signInAndSettle(page, admin, PW, '/admin');
    const rows = (await (await page.request.get('/api/admin/analytics/scorecard')).json()).rows;
    const row = (key: string) => rows.find((r: { key: string }) => r.key === key);
    expect(row('nps')).toMatchObject({ status: 'ok', value: 17, basis: 6, unit: 'score', band: 'AMBER', target: 30, nextAction: '/admin/surveys' });
    expect(row('surveyResponseRate')).toMatchObject({ status: 'ok', value: 50, basis: 10, band: 'GREEN', nextAction: null });

    await page.goto('/admin/analytics');
    await expect(page.getByTestId('scorecard-value-nps')).toHaveText('17');
    await expect(page.getByTestId('scorecard-action-nps')).toHaveAttribute('href', '/admin/surveys');

    await page.goto('/admin/analytics/report');
    await expect(page.getByTestId(`report-survey-${survey.id}`)).toContainText('17 (n=6)');

    const xlsx = await (await page.request.get('/api/admin/export/analytics')).json();
    const sheet = xlsx.sheets.find((s: { name: string }) => s.name === 'Surveys');
    // Invited 10, responses 6, rate 5/10 = 50 %, NPS 17 over 6 answers.
    expect(sheet.rows.find((r: (string | number)[]) => r[0] === `Programme pulse ${stamp}`)).toEqual([`Programme pulse ${stamp}`, 'Open', 'Anonymous', 10, 6, '50%', 17, 6]);
  });

  test('ADMIN only, checked in the handler', async ({ page }) => {
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/analytics/scorecard')).status()).toBe(403);
    expect((await page.request.get('/api/admin/analytics/surveys')).status()).toBe(403);
    await signInAsFreshUser(page, mentees[0], PW, '/portal');
    expect((await page.request.get('/api/admin/analytics/scorecard')).status()).toBe(403);
  });
});
