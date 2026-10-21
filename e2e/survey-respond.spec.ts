import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { createSurvey, hashSurveyToken } from '../src/lib/surveys';
import { createSurveyInvitation } from '../src/lib/surveyTokens';

// Answering a survey from the mailed link with no login (#1881). Every page
// visit here is SIGNED OUT — the invitation token is the only credential.

const QUESTIONS: Parameters<typeof createSurvey>[1]['questions'] = [
  { key: 'nps', type: 'NPS', labels: { en: 'How likely are you to recommend the programme?' }, required: true },
  { key: 'best', type: 'LONG_TEXT', labels: { en: 'What worked best?' } },
];

test.describe('survey answering by token', () => {
  const stamp = `${Date.now()}`;
  const mentee = uniqueEmail('sr-mentee');
  let orgId = '';
  let menteeId = '';

  const openSurvey = async (anonymity: 'ANONYMOUS' | 'IDENTIFIED', extra: { closesAt?: string } = {}) => {
    const survey = await createSurvey(orgId, { key: 'program_post', title: { en: `Programme survey ${stamp}` }, audience: 'MENTEE', anonymity, questions: QUESTIONS, ...extra });
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
    return survey;
  };

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `SR Org ${stamp}`, slug: `sr-${stamp}` } })).id;
    menteeId = (await seedUser(mentee, 'SurveyRespond123!', 'MENTEE', `SR Mentee ${stamp}`, orgId)).id;
  });

  test.afterAll(async () => {
    await prisma.survey.deleteMany({ where: { orgId } });
    await cleanupByEmail(mentee);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('a signed-out browser answers from the link, once; anonymous answers carry no identity', { tag: '@smoke' }, async ({ page }) => {
    const survey = await openSurvey('ANONYMOUS');
    const invite = await createSurveyInvitation({ surveyId: survey.id, orgId, email: mentee, userId: menteeId, locale: 'en' });
    expect(invite).not.toBeNull();
    // Only the hash is stored; the token itself appears nowhere in the row.
    const row = await prisma.surveyInvitation.findUniqueOrThrow({ where: { id: invite!.invitationId } });
    expect(row.tokenHash).toBe(hashSurveyToken(invite!.token));
    expect(JSON.stringify(row)).not.toContain(invite!.token);

    await page.goto(`/s/${invite!.token}`);
    await expect(page.getByTestId('survey-respond')).toContainText(`Programme survey ${stamp}`);
    await expect(page.getByTestId('survey-anonymity')).toContainText('anonymous');
    // The shared validator runs in the browser too: NPS is required.
    await page.getByTestId('survey-submit').click();
    await expect(page.getByTestId('survey-q-nps').getByRole('alert')).toHaveText('Please answer this question.');
    await page.getByTestId('survey-nps-9').click();
    await page.getByTestId('survey-best-text').fill('The weekly check-ins');
    await page.getByTestId('survey-submit').click();
    await expect(page.getByTestId('survey-thanks')).toBeVisible();

    const responses = await prisma.surveyResponse.findMany({ where: { surveyId: survey.id }, include: { answers: true } });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ respondentId: null, invitationId: null, respondentRole: 'MENTEE' });
    expect(responses[0].answers.find((a) => a.questionKey === 'nps')?.value).toBe(9);
    expect((await prisma.surveyInvitation.findUniqueOrThrow({ where: { id: invite!.invitationId } })).respondedAt).not.toBeNull();

    // Re-opening the link says so — it does not show the form again.
    await page.goto(`/s/${invite!.token}`);
    await expect(page.getByTestId('survey-state-alreadyAnswered')).toBeVisible();
    // And a replayed POST is a friendly state, not a second response.
    const replay = await page.request.post('/api/surveys/respond', { data: { token: invite!.token, answers: { nps: 1 } } });
    expect(await replay.json()).toEqual({ state: 'alreadyAnswered' });
    expect(await prisma.surveyResponse.count({ where: { surveyId: survey.id } })).toBe(1);
  });

  test('expired, unknown and closed links each say so', async ({ page }) => {
    const survey = await openSurvey('IDENTIFIED');
    const expired = await createSurveyInvitation({ surveyId: survey.id, orgId, email: `expired-${stamp}@example.com`, ttlDays: -1 });
    await page.goto(`/s/${expired!.token}`);
    await expect(page.getByTestId('survey-state-expired')).toHaveText('This survey link has expired.');

    await page.goto('/s/notARealTokenButLongEnough_123456');
    await expect(page.getByTestId('survey-state-invalid')).toBeVisible();

    const closed = await openSurvey('IDENTIFIED', { closesAt: new Date(Date.now() - 60_000).toISOString() });
    const invite = await createSurveyInvitation({ surveyId: closed.id, orgId, email: `closed-${stamp}@example.com` });
    await page.goto(`/s/${invite!.token}`);
    await expect(page.getByTestId('survey-state-closed')).toBeVisible();
  });

  test('on a phone it is one question per screen, and an identified answer keeps its owner', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const survey = await openSurvey('IDENTIFIED');
    const invite = await createSurveyInvitation({ surveyId: survey.id, orgId, email: `phone-${stamp}@example.com`, userId: menteeId });
    await page.goto(`/s/${invite!.token}`);
    await expect(page.getByTestId('survey-progress')).toHaveText('Question 1 of 2');
    await expect(page.getByTestId('survey-q-best')).toBeHidden();
    await page.getByTestId('survey-nps-7').click();
    await page.getByTestId('survey-next').click();
    await expect(page.getByTestId('survey-progress')).toHaveText('Question 2 of 2');
    await expect(page.getByTestId('survey-q-nps')).toBeHidden();
    await page.getByTestId('survey-submit').click();
    await expect(page.getByTestId('survey-thanks')).toBeVisible();
    expect(await prisma.surveyResponse.findFirstOrThrow({ where: { surveyId: survey.id } })).toMatchObject({ respondentId: menteeId });
  });
});
