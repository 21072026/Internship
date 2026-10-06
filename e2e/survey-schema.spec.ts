import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { submitSurveyResponse, mintSurveyToken } from '../src/lib/surveys';

// The survey engine's write-boundary rules (#1879). Its own org.
//   • An ANONYMOUS response row carries no respondent and no invitation —
//     read back from the database, not from an API that might filter it.
//   • The invitation is still stamped as answered, and answers only once.
//   • Once a survey is OPEN its question keys are frozen (409).

const PW = 'SurveySchema123!';

const body = (anonymity: string) => ({
  key: 'program_post',
  title: { en: 'How was the programme?' },
  audience: 'MENTEE',
  anonymity,
  questions: [
    { key: 'nps', type: 'NPS', labels: { en: 'How likely are you to recommend it?' }, required: true },
    { key: 'best', type: 'LONG_TEXT', labels: { en: 'What worked best?' } },
  ],
});

test.describe('survey schema', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('sv-admin');
  const mentee = uniqueEmail('sv-mentee');
  let orgId = '';
  let menteeId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `SV Org ${stamp}`, slug: `sv-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `SV Admin ${stamp}`, orgId);
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `SV Mentee ${stamp}`, orgId)).id;
  });

  test.afterAll(async () => {
    await prisma.survey.deleteMany({ where: { orgId } });
    for (const email of [admin, mentee]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('anonymous is severed in the database; identified keeps the link; one answer per invitation', { tag: '@smoke' }, async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const created = await page.request.post('/api/admin/surveys', { data: body('ANONYMOUS') });
    expect(created.status()).toBe(201);
    const anon = (await created.json()).survey;
    expect(anon).toMatchObject({ orgId, anonymity: 'ANONYMOUS', status: 'DRAFT', minResponses: 5 });
    expect((await page.request.patch(`/api/admin/surveys/${anon.id}`, { data: { status: 'OPEN' } })).status()).toBe(200);

    const invite = await prisma.surveyInvitation.create({
      data: { orgId, surveyId: anon.id, userId: menteeId, email: mentee, tokenHash: mintSurveyToken().tokenHash, expiresAt: new Date(Date.now() + 86400000) },
    });
    const saved = await submitSurveyResponse({ surveyId: anon.id, invitationId: invite.id, respondentId: menteeId, respondentRole: 'MENTEE', answers: { nps: 9, best: 'The weekly check-ins' } });

    const row = await prisma.surveyResponse.findUniqueOrThrow({ where: { id: saved.id }, include: { answers: true } });
    expect(row.respondentId).toBeNull();
    expect(row.invitationId).toBeNull();
    expect(row.respondentRole).toBe('MENTEE');
    expect(row.answers.find((a) => a.questionKey === 'best')?.text).toBe('The weekly check-ins');
    expect((await prisma.surveyInvitation.findUniqueOrThrow({ where: { id: invite.id } })).respondedAt).not.toBeNull();
    // No column anywhere ties the answer back to the person.
    expect(await prisma.surveyResponse.count({ where: { respondentId: menteeId } })).toBe(0);

    // The same invitation cannot answer twice.
    await expect(submitSurveyResponse({ surveyId: anon.id, invitationId: invite.id, respondentRole: 'MENTEE', answers: { nps: 3 } })).rejects.toMatchObject({ code: 'already_responded' });
    // The shared validator runs on the write: NPS is 0..10.
    await expect(submitSurveyResponse({ surveyId: anon.id, respondentRole: 'MENTEE', answers: { nps: 11 } })).rejects.toMatchObject({ errors: { nps: 'out_of_range' } });

    // IDENTIFIED keeps both links.
    const ident = (await (await page.request.post('/api/admin/surveys', { data: body('IDENTIFIED') })).json()).survey;
    await page.request.patch(`/api/admin/surveys/${ident.id}`, { data: { status: 'OPEN' } });
    const kept = await submitSurveyResponse({ surveyId: ident.id, respondentId: menteeId, respondentRole: 'MENTEE', answers: { nps: 8 } });
    expect(await prisma.surveyResponse.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ respondentId: menteeId });
  });

  test('question keys are frozen once a survey opens, and it never returns to draft', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const survey = (await (await page.request.post('/api/admin/surveys', { data: body('CONFIDENTIAL') })).json()).survey;
    const renamed = body('CONFIDENTIAL').questions.map((q) => (q.key === 'best' ? { ...q, key: 'best_part' } : q));

    // In DRAFT a key may still change.
    expect((await page.request.patch(`/api/admin/surveys/${survey.id}`, { data: { questions: renamed } })).status()).toBe(200);
    await page.request.patch(`/api/admin/surveys/${survey.id}`, { data: { status: 'OPEN' } });

    const rekey = await page.request.patch(`/api/admin/surveys/${survey.id}`, { data: { questions: body('CONFIDENTIAL').questions } });
    expect(rekey.status()).toBe(409);
    expect(await rekey.json()).toMatchObject({ code: 'questions_locked' });
    // Re-wording the same keys is fine.
    const reworded = renamed.map((q) => ({ ...q, labels: { en: `${q.labels.en} (updated)` } }));
    expect((await page.request.patch(`/api/admin/surveys/${survey.id}`, { data: { questions: reworded } })).status()).toBe(200);
    expect((await page.request.patch(`/api/admin/surveys/${survey.id}`, { data: { status: 'DRAFT' } })).status()).toBe(409);
    // The floor can be raised, never lowered.
    expect((await page.request.patch(`/api/admin/surveys/${survey.id}`, { data: { minResponses: 3 } })).status()).toBe(400);
    expect((await page.request.patch(`/api/admin/surveys/${survey.id}`, { data: { minResponses: 8 } })).status()).toBe(200);
  });

  test('ADMIN only', async ({ page }) => {
    await signInAsFreshUser(page, mentee, PW, '/portal');
    expect((await page.request.get('/api/admin/surveys')).status()).toBe(403);
    expect((await page.request.post('/api/admin/surveys', { data: body('ANONYMOUS') })).status()).toBe(403);
  });
});
