import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { createSurvey, submitSurveyResponse } from '../src/lib/surveys';
import { prepareOpenText } from '../src/lib/ai/openTextRules';
import { openTextInputHash } from '../src/lib/ai/summarizeOpenText';

// Survey results (#1910). Its own org: three mentors with 6, 2 and 5 mentees.
//   • under the floor (4 responses) nothing but counts leaves the server;
//   • at 13 responses: NPS, distributions, free text sorted — and the mentor
//     breakdown hides B (2) AND C (5, the residual: 2 alone would be
//     recoverable by subtraction), and neither is sent at all;
//   • an ANONYMOUS response stores no relation, so there is no cohort or
//     mentor breakdown to show;
//   • a mentor gets 403, another tenant's survey is 404.

const PW = 'SurveyResults123!';

const QUESTIONS: Parameters<typeof createSurvey>[1]['questions'] = [
  { key: 'nps', type: 'NPS', labels: { en: 'Would you recommend the programme?' }, required: true },
  {
    key: 'track',
    type: 'SELECT',
    labels: { en: 'Your track' },
    options: [
      { value: 'fe', labels: { en: 'Frontend' } },
      { value: 'be', labels: { en: 'Backend' } },
    ],
  },
  { key: 'best', type: 'LONG_TEXT', labels: { en: 'What worked best?' } },
];

test.describe('survey results', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('sr-admin');
  const mentors = ['a', 'b', 'c'].map((k) => uniqueEmail(`sr-mentor-${k}`));
  const menteeEmails: string[] = [];
  let orgId = '';
  let otherOrgId = '';
  const mentorIds: string[] = [];
  // relation ids per mentor, in the order A (6), B (2), C (5)
  const relations: string[][] = [[], [], []];
  const menteeIds: string[][] = [[], [], []];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `SR Org ${stamp}`, slug: `sr-${stamp}` } })).id;
    otherOrgId = (await prisma.organization.create({ data: { name: `SR Other ${stamp}`, slug: `sr-other-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `SR Admin ${stamp}`, orgId);
    const cohort = await prisma.cohort.create({ data: { orgId, name: `Spring ${stamp}` } });
    for (const [i, email] of mentors.entries()) {
      mentorIds.push((await seedUser(email, PW, 'MENTOR', `SR Mentor ${'ABC'[i]} ${stamp}`, orgId)).id);
    }
    for (const [i, size] of [6, 2, 5].entries()) {
      for (let j = 0; j < size; j++) {
        const email = uniqueEmail(`sr-mentee-${i}-${j}`);
        menteeEmails.push(email);
        // Never signs in — no bcrypt needed.
        const mentee = await prisma.user.create({ data: { email, password: 'x', role: 'MENTEE', fullName: `SR Mentee ${i}-${j}`, skills: [], orgId } });
        menteeIds[i].push(mentee.id);
        const rel = await prisma.mentorshipRelation.create({
          data: { orgId, mentorId: mentorIds[i], menteeId: mentee.id, ...(i === 0 ? { cohortId: cohort.id } : {}) },
        });
        relations[i].push(rel.id);
      }
    }
  });

  test.afterAll(async () => {
    await prisma.aiArtifact.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await prisma.survey.deleteMany({ where: { orgId: { in: [orgId, otherOrgId] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.cohort.deleteMany({ where: { orgId } });
    for (const email of [admin, ...mentors, ...menteeEmails]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.$disconnect();
  });

  test('floor − 1 shows only counts; at the floor the score, distributions and floored breakdowns appear', async ({ page }) => {
    const survey = await createSurvey(orgId, { key: 'post', title: { en: `Programme survey ${stamp}` }, audience: 'MENTEE', anonymity: 'CONFIDENTIAL', questions: QUESTIONS });
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
    const scores = [[10, 10, 9, 9, 8, 3], [2, 1], [9, 9, 7, 6, 10]];
    const texts: Record<string, string> = { '0-0': 'Zebra-striped code reviews', '2-1': 'Apple-pie pairing sessions' };
    const submit = (i: number, j: number) =>
      submitSurveyResponse({
        surveyId: survey.id,
        respondentId: menteeIds[i][j],
        respondentRole: 'MENTEE',
        relationId: relations[i][j],
        answers: { nps: scores[i][j], track: j % 2 === 0 ? 'fe' : 'be', ...(texts[`${i}-${j}`] ? { best: texts[`${i}-${j}`] } : {}) },
      });

    for (let j = 0; j < 4; j++) await submit(0, j);
    await signInAndSettle(page, admin, PW, '/admin');
    const under = (await (await page.request.get(`/api/admin/surveys/${survey.id}/results`)).json()).results;
    expect(under).toMatchObject({ n: 4, floor: 5, suppressed: true, breakdowns: null });
    for (const q of under.questions) {
      expect(Object.keys(q).sort()).toEqual(['answered', 'key', 'label', 'type']);
    }
    expect(JSON.stringify(under)).not.toContain('Zebra');
    await page.goto(`/admin/surveys/${survey.id}/results`);
    await expect(page.getByTestId('results-suppressed')).toBeVisible();
    await expect(page.getByTestId('nps-score')).toHaveCount(0);

    for (let j = 4; j < 6; j++) await submit(0, j);
    for (const i of [1, 2]) for (let j = 0; j < scores[i].length; j++) await submit(i, j);

    const res = await page.request.get(`/api/admin/surveys/${survey.id}/results`);
    expect(res.status()).toBe(200);
    const r = (await res.json()).results;
    expect(r).toMatchObject({ n: 13, suppressed: false });
    const nps = r.questions.find((q: { key: string }) => q.key === 'nps');
    // 7 promoters, 2 passives, 4 detractors of 13 → round(3/13·100) = 23.
    expect(nps.nps).toMatchObject({ suppressed: false, n: 13, promoters: 7, passives: 2, detractors: 4, score: 23 });
    expect(nps.distribution.find((b: { value: string }) => b.value === '10').count).toBe(3);
    const track = r.questions.find((q: { key: string }) => q.key === 'track');
    expect(track.distribution.map((b: { label: string; count: number }) => [b.label, b.count])).toEqual([['Frontend', 7], ['Backend', 6]]);
    // Alphabetical, never in arrival order.
    expect(r.questions.find((q: { key: string }) => q.key === 'best').texts).toEqual(['Apple-pie pairing sessions', 'Zebra-striped code reviews']);

    // Mentor A (6) shown; B (2) hidden, and C (5) hidden with it — 2 alone
    // would come back by subtraction. Neither is in the payload at all.
    expect(r.breakdowns.mentor.shown).toEqual([{ key: mentorIds[0], label: `SR Mentor A ${stamp}`, n: 6, nps: expect.objectContaining({ score: 50 }) }]);
    expect(r.breakdowns.mentor.hidden).toBe(true);
    const payload = JSON.stringify(r);
    for (const i of [1, 2]) {
      expect(payload).not.toContain(mentorIds[i]);
      expect(payload).not.toContain(`SR Mentor ${'ABC'[i]} ${stamp}`);
    }
    // Only A's pairs are in a cohort: one group, nothing held back.
    expect(r.breakdowns.cohort).toMatchObject({ shown: [{ label: `Spring ${stamp}`, n: 6 }], hidden: false });
    expect(r.breakdowns.role.shown).toMatchObject([{ key: 'MENTEE', n: 13 }]);

    await page.goto('/admin/surveys');
    await expect(page.getByTestId(`survey-results-link-${survey.id}`)).toHaveAttribute('href', `/admin/surveys/${survey.id}/results`);
    await page.goto(`/admin/surveys/${survey.id}/results`);
    await expect(page.getByTestId('nps-score')).toHaveText('23');
    await expect(page.getByTestId('breakdown-mentor-hidden')).toBeVisible();
    await expect(page.getByTestId('breakdown-mentor-row')).toHaveCount(1);
  });

  test('the AI summary runs only above the floor and degrades to the plain list when AI is unavailable', async ({ page }) => {
    const survey = await createSurvey(orgId, { key: 'ai', title: { en: `AI survey ${stamp}` }, audience: 'MENTEE', anonymity: 'ANONYMOUS', questions: QUESTIONS });
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
    const answer = (best: string) => submitSurveyResponse({ surveyId: survey.id, respondentRole: 'MENTEE', answers: { nps: 9, best } });
    for (const best of ['Pairing sessions', 'The weekly check-ins', 'Mock interviews', 'Code reviews']) await answer(best);

    await signInAndSettle(page, admin, PW, '/admin');
    const summarise = () => page.request.post(`/api/admin/surveys/${survey.id}/summary`, { data: { questionKey: 'best' } });
    // Four responses: under the floor, so nothing is summarised either.
    const under = await summarise();
    expect(under.status()).toBe(409);
    expect((await under.json()).code).toBe('below_floor');

    await answer('Feedback on my CV');
    // A question that is not free text is refused.
    expect((await page.request.post(`/api/admin/surveys/${survey.id}/summary`, { data: { questionKey: 'nps' } })).status()).toBe(400);
    // No provider in this environment: a typed reason, never an error.
    const res = await summarise();
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.summary).toBeNull();
    expect(['quota_exceeded', 'not_configured']).toContain(body.reason);

    await page.goto(`/admin/surveys/${survey.id}/results`);
    await page.getByTestId('ai-summarise-best').click();
    await expect(page.getByTestId('ai-note-best')).toBeVisible();
    // The plain list is still all there.
    await expect(page.getByTestId('texts-best').locator('li')).toHaveCount(5);

    // On the open-text engine (#2046): a stored summary for exactly these
    // answers is answered without a provider call, and each theme opens the
    // answers it was built from — by position in the list on the page.
    const results = (await (await page.request.get(`/api/admin/surveys/${survey.id}/results`)).json()).results;
    const best = results.questions.find((q: { key: string }) => q.key === 'best');
    const { prepared } = prepareOpenText(best.texts.map((text: string, i: number) => ({ id: `${survey.id}/best/${i}`, text })));
    const mock = best.texts.indexOf('Mock interviews');
    const cv = best.texts.indexOf('Feedback on my CV');
    await prisma.aiArtifact.create({
      data: {
        orgId,
        taskId: 'survey_summary',
        createdById: (await prisma.user.findFirstOrThrow({ where: { email: admin } })).id,
        inputHash: openTextInputHash({ purpose: `written answers to one survey question: "${best.label}"`, locale: 'en' }, prepared),
        content: JSON.stringify({
          themes: [{ label: 'Interview practice', count: 2, exampleIds: [`${survey.id}/best/${mock}`, `${survey.id}/best/${cv}`], sentiment: 'positive' }],
          overall: { positive: 2, neutral: 3, negative: 0, unclear: 0 },
          notableQuotes: [{ id: `${survey.id}/best/${mock}`, text: 'Mock interviews' }],
          caveats: [],
          sent: 5,
        }),
      },
    });
    const usageBefore = await prisma.aiUsage.count();
    const stored = await (await summarise()).json();
    expect(stored).toMatchObject({ cached: true, summary: { themes: [{ label: 'Interview practice', count: 2, sentiment: 'positive', answers: [mock, cv] }], quotes: ['Mock interviews'] } });
    expect(await prisma.aiUsage.count()).toBe(usageBefore);
    await page.reload();
    await page.getByTestId('ai-summarise-best').click();
    const theme = page.getByTestId('ai-theme-best');
    await expect(theme).toContainText('Interview practice');
    await expect(theme).toContainText('mostly positive');
    await theme.getByRole('button').click();
    await expect(page.getByTestId('ai-theme-answers-best').locator('li')).toHaveText(['Mock interviews', 'Feedback on my CV']);
  });

  test('an anonymous response stores no relation, so there is no cohort or mentor breakdown', async ({ page }) => {
    const survey = await createSurvey(orgId, { key: 'anon', title: { en: `Anonymous survey ${stamp}` }, audience: 'MENTEE', anonymity: 'ANONYMOUS', questions: QUESTIONS });
    await prisma.survey.update({ where: { id: survey.id }, data: { status: 'OPEN' } });
    for (let j = 0; j < 5; j++) {
      await submitSurveyResponse({ surveyId: survey.id, respondentId: menteeIds[0][j], respondentRole: 'MENTEE', relationId: relations[0][j], answers: { nps: 9 } });
    }
    const rows = await prisma.surveyResponse.findMany({ where: { surveyId: survey.id } });
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.relationId === null && row.respondentId === null)).toBe(true);

    await signInAndSettle(page, admin, PW, '/admin');
    const r = (await (await page.request.get(`/api/admin/surveys/${survey.id}/results`)).json()).results;
    expect(r.breakdowns).toMatchObject({ cohort: null, mentor: null, role: { shown: [{ key: 'MENTEE', n: 5 }] } });
  });

  test('a mentor is refused; another tenant\'s survey is not found', async ({ page }) => {
    const mine = await createSurvey(orgId, { key: 'mine', title: { en: 'Mine' }, audience: 'MENTEE', anonymity: 'CONFIDENTIAL', questions: QUESTIONS });
    const theirs = await createSurvey(otherOrgId, { key: 'theirs', title: { en: 'Theirs' }, audience: 'MENTEE', anonymity: 'CONFIDENTIAL', questions: QUESTIONS });
    await signInAndSettle(page, admin, PW, '/admin');
    expect((await page.request.get(`/api/admin/surveys/${theirs.id}/results`)).status()).toBe(404);
    await page.context().clearCookies();
    await signInAndSettle(page, mentors[0], PW, '/mentor');
    expect((await page.request.get(`/api/admin/surveys/${mine.id}/results`)).status()).toBe(403);
    expect((await page.request.post(`/api/admin/surveys/${mine.id}/summary`, { data: { questionKey: 'best' } })).status()).toBe(403);
  });
});
