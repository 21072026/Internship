import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { createSurveyInvitation } from '../src/lib/surveyTokens';
import { setOrgFeatureFor } from './helpers/entitlements';

// First destination, part 2 (#1912): the screen and its report pack, the XLSX
// sheet, the scorecard row, and the pre-filled answer for a hire our own
// pipeline already recorded.

const PW = 'OutcomeReport123!';
const DAY = 24 * 60 * 60 * 1000;

test.describe('first destination report', () => {
  // The second test reads the survey the first one set up through the screen.
  test.describe.configure({ mode: 'serial' });
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('or-admin');
  const mentor = uniqueEmail('or-mentor');
  const mentees = [0, 1, 2, 3, 4, 5].map((i) => uniqueEmail(`or-mentee-${i}`));
  let orgId = '';
  const menteeIds: string[] = [];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `OR Org ${stamp}`, slug: `or-${stamp}` } })).id;
    const cohort = await prisma.cohort.create({ data: { orgId, name: `Autumn ${stamp}` } });
    await seedUser(admin, PW, 'ADMIN', `OR Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `OR Mentor ${stamp}`, orgId);
    for (const [i, email] of mentees.entries()) {
      const id = (await seedUser(email, PW, 'MENTEE', `OR Mentee ${i} ${stamp}`, orgId)).id;
      menteeIds.push(id);
      await prisma.mentorshipRelation.create({
        data: {
          orgId,
          mentorId: m.id,
          menteeId: id,
          status: 'COMPLETED',
          completedAt: new Date(Date.now() - 30 * DAY),
          cohortId: cohort.id,
          // Mentee 5 was hired through our own pipeline.
          pipelineStatus: i === 5 ? 'HIRED_660' : 'INTERNSHIP_COMPLETED_490',
        },
      });
    }
  });

  test.afterAll(async () => {
    await prisma.survey.deleteMany({ where: { orgId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.cohort.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('the screen sets the survey up, shows the table with its knowledge rate, and feeds the XLSX and the scorecard', async ({ page }) => {
    test.slow();
    await signInAndSettle(page, admin, PW, '/admin');
    await page.goto('/admin/analytics');
    await page.getByTestId('outcomes-link').click();
    await page.waitForURL('**/admin/analytics/outcomes');

    // Not set up yet: one click does it.
    const setup = page.getByTestId('outcomes-setup');
    await expect(setup.getByTestId('outcomes-setup-button')).toBeVisible();
    await setup.getByTestId('outcomes-setup-button').click();
    await expect(setup.getByTestId('outcomes-setup-active')).toContainText('90');
    // …and a second offset is one more click.
    await setup.getByTestId('outcomes-offset').selectOption('180');
    await setup.getByTestId('outcomes-setup-button').click();
    await expect(setup.getByTestId('outcomes-setup-active')).toContainText('180');

    // Five consented answers — at the floor.
    const survey = await prisma.survey.findFirstOrThrow({ where: { orgId, templateKey: 'outcome_destination' } });
    const destinations = ['EMPLOYED_ELSEWHERE', 'EMPLOYED_ELSEWHERE', 'CONTINUING_STUDY', 'SEEKING', 'EMPLOYED_HERE'];
    for (const [i, destination] of destinations.entries()) {
      await prisma.surveyResponse.create({
        data: {
          orgId,
          surveyId: survey.id,
          respondentId: menteeIds[i],
          respondentRole: 'MENTEE',
          answers: { create: [{ questionKey: 'destination', value: destination }, { questionKey: 'consent', value: true }] },
        },
      });
    }
    await page.reload();
    await expect(page.getByTestId('outcomes-tile-eligible')).toContainText('6');
    await expect(page.getByTestId('outcomes-tile-known')).toContainText('5');
    await expect(page.getByTestId('outcomes-tile-rate')).toContainText('83%');
    await expect(page.getByTestId('outcomes-tile-placed')).toContainText('80%');
    await expect(page.getByTestId('outcomes-row-EMPLOYED_ELSEWHERE')).toContainText('2');
    await expect(page.getByTestId('outcomes-by-cohort')).toContainText(`Autumn ${stamp}`);
    await expect(page.getByTestId('outcomes-print-button')).toBeVisible();

    // The XLSX carries the same numbers, knowledge rate included.
    await setOrgFeatureFor(page, 'REPORT_EXPORT', true);
    const wb = await (await page.request.get('/api/admin/export/analytics')).json();
    const sheet = wb.sheets.find((s: { name: string }) => s.name === 'Destinations');
    expect(sheet).toBeTruthy();
    const overall = sheet.rows[0];
    expect(overall.slice(2, 6)).toEqual([6, 5, 0, '83%']);

    // …and so does the scorecard.
    const rows = (await (await page.request.get('/api/admin/analytics/scorecard')).json()).rows;
    expect(rows.find((r: { key: string }) => r.key === 'destinationKnown')).toMatchObject({ status: 'ok', value: 83, basis: 6, band: 'GREEN' });
  });

  test('a hire our own pipeline recorded opens the question pre-selected — and only then', async ({ page }) => {
    const survey = await prisma.survey.findFirst({ where: { orgId, templateKey: 'outcome_destination' } });
    test.skip(!survey, 'set up by the previous test');
    const hired = await createSurveyInvitation({ surveyId: survey!.id, orgId, email: mentees[5], userId: menteeIds[5], locale: 'en' });
    const notHired = await createSurveyInvitation({ surveyId: survey!.id, orgId, email: mentees[4], userId: menteeIds[4], locale: 'en' });
    expect(hired && notHired).toBeTruthy();

    const read = async (token: string) => (await page.request.get(`/api/surveys/respond?token=${token}`)).json();
    expect((await read(hired!.token)).prefill).toEqual({ destination: 'EMPLOYED_HERE' });
    expect((await read(notHired!.token)).prefill).toBeUndefined();

    // On the page, the option starts checked; the participant can still change it.
    await page.goto(`/s/${hired!.token}`);
    await expect(page.getByRole('radio', { name: 'Working at the organisation I was placed with' })).toBeChecked();
  });
});
