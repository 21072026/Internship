import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { createSurveyInvitation } from '../src/lib/surveyTokens';

// A survey made from a built-in instrument (#1877): the admin picks it on
// /admin/surveys, the wording lands in all three languages, "open and send
// now" opens it and adds a MANUAL campaign, and the mailed link answers it
// signed out. An instrument that words its question differently for mentors is
// never one survey for both roles.

const PW = 'SurveyCreate123!';

test.describe('survey from an instrument', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('sc-admin');
  const mentee = uniqueEmail('sc-mentee');
  let orgId = '';
  let menteeId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `SC Org ${stamp}`, slug: `sc-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `SC Admin ${stamp}`, orgId);
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `SC Mentee ${stamp}`, orgId)).id;
  });

  test.afterAll(async () => {
    await prisma.surveyCampaign.deleteMany({ where: { orgId } });
    await prisma.survey.deleteMany({ where: { orgId } });
    for (const email of [admin, mentee]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('an admin creates, opens and sends an instrument; the link answers it signed out', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    await page.goto('/admin/surveys');
    const form = page.getByTestId('survey-create');
    await form.getByTestId('survey-create-instrument').selectOption('nps_only');
    // nps_only words nothing differently for mentors, so one survey may ask both.
    await form.getByTestId('survey-create-audience').selectOption('BOTH');
    await expect(form.getByTestId('survey-create-anonymity')).toHaveValue('ANONYMOUS');
    await form.getByTestId('survey-create-send-now').check();
    await form.getByTestId('survey-create-submit').click();
    await expect(form.getByTestId('survey-create-message')).toHaveAttribute('role', 'status');

    const survey = await prisma.survey.findFirstOrThrow({ where: { orgId }, include: { questions: true, campaigns: true } });
    expect(survey).toMatchObject({ templateKey: 'nps_only', key: 'nps_only', audience: 'BOTH', anonymity: 'ANONYMOUS', status: 'OPEN' });
    for (const q of survey.questions) {
      const labels = q.labels as Record<string, string>;
      expect(labels.en && labels.tr && labels.de).toBeTruthy();
    }
    expect(survey.campaigns).toHaveLength(1);
    expect(survey.campaigns[0]).toMatchObject({ trigger: 'MANUAL', active: true });
    await expect(page.getByTestId(`survey-row-${survey.id}`)).toBeVisible();

    // What the dispatcher would mail; answered with no session.
    const invite = await createSurveyInvitation({ surveyId: survey.id, orgId, email: mentee, userId: menteeId, locale: 'en' });
    await page.context().clearCookies();
    await page.goto(`/s/${invite!.token}`);
    await page.getByTestId('survey-nps-10').click();
    await page.getByTestId('survey-submit').click();
    await expect(page.getByTestId('survey-thanks')).toBeVisible();
    expect(await prisma.surveyResponse.count({ where: { surveyId: survey.id } })).toBe(1);
  });

  test('an instrument with mentor wording is one survey per role; an unknown one is refused', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const post = (data: unknown) => page.request.post('/api/admin/surveys', { data });
    const both = await post({ templateKey: 'program_post', audience: 'BOTH' });
    expect(both.status()).toBe(400);
    expect((await both.json()).code).toBe('unsupported_template');
    expect((await post({ templateKey: 'no_such_instrument' })).status()).toBe(400);

    const mentee = await (await post({ templateKey: 'program_post', audience: 'MENTEE' })).json();
    const mentor = await (await post({ templateKey: 'program_post', audience: 'MENTOR' })).json();
    expect(mentee.survey).toMatchObject({ status: 'DRAFT', audience: 'MENTEE', anonymity: 'CONFIDENTIAL' });
    const outcome = (s: { questions: { key: string; labels: { en: string } }[] }) => s.questions.find((q) => q.key === 'outcome')!.labels.en;
    expect(outcome(mentor.survey)).not.toBe(outcome(mentee.survey));

    await page.goto('/admin/surveys');
    await page.getByTestId('survey-create-instrument').selectOption('program_post');
    await expect(page.getByTestId('survey-create-audience').locator('option')).toHaveCount(2);
  });
});
