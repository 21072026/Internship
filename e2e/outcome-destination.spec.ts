import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// First destination (#1912): the instrument is set up in one call, the
// DAYS_AFTER_END campaign invites the people whose relation completed that many
// days ago, and the report carries its knowledge rate, counts only consented
// answers and applies the response floor per bucket.

const PW = 'Outcome123!';
const DAY = 24 * 60 * 60 * 1000;

test.describe('first destination', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('od-admin');
  const mentor = uniqueEmail('od-mentor');
  const mentees = [0, 1, 2, 3, 4, 5, 6].map((i) => uniqueEmail(`od-mentee-${i}`));
  let orgId = '';
  const menteeIds: string[] = [];
  const relationIds: string[] = [];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `OD Org ${stamp}`, slug: `od-${stamp}` } })).id;
    const cohort = await prisma.cohort.create({ data: { orgId, name: `Spring ${stamp}` } });
    await seedUser(admin, PW, 'ADMIN', `OD Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `OD Mentor ${stamp}`, orgId);
    for (const [i, email] of mentees.entries()) {
      const id = (await seedUser(email, PW, 'MENTEE', `OD Mentee ${i} ${stamp}`, orgId)).id;
      menteeIds.push(id);
      // Six completed 89 days ago in the Spring cohort; the seventh ten days
      // ago with no cohort — eligible for the report, not yet due a survey.
      const completedAt = new Date(Date.now() - (i < 6 ? 89 : 10) * DAY);
      relationIds.push(
        (await prisma.mentorshipRelation.create({
          data: { orgId, mentorId: m.id, menteeId: id, status: 'COMPLETED', completedAt, cohortId: i < 6 ? cohort.id : null },
        })).id,
      );
    }
  });

  test.afterAll(async () => {
    await prisma.emailLog.deleteMany({ where: { to: { in: mentees } } });
    await prisma.survey.deleteMany({ where: { orgId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.cohort.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('set up in one call, sent 90 days after the end, reported with its knowledge rate and floor', async ({ page }) => {
    test.slow();
    await signInAndSettle(page, admin, PW, '/admin');

    // One call: an open survey from the template, and a 90-day campaign.
    const setup = await page.request.post('/api/admin/analytics/outcomes', { data: {} });
    expect(setup.status()).toBe(201);
    const { surveyId, status, campaigns } = (await setup.json()).setup;
    expect(status).toBe('OPEN');
    expect(campaigns).toEqual([expect.objectContaining({ dayOffset: 90, active: true })]);
    // Idempotent: again is the same survey, no second campaign.
    const again = await page.request.post('/api/admin/analytics/outcomes', { data: {} });
    expect(again.status()).toBe(200);
    expect((await again.json()).setup.surveyId).toBe(surveyId);
    expect((await page.request.post('/api/admin/analytics/outcomes', { data: { dayOffset: 45 } })).status()).toBe(400);
    const survey = await prisma.survey.findUniqueOrThrow({ where: { id: surveyId }, include: { questions: { orderBy: { sortOrder: 'asc' } } } });
    expect(survey.templateKey).toBe('outcome_destination');
    expect(survey.questions.map((q) => [q.key, q.type])).toEqual([['destination', 'SELECT'], ['employer_role', 'TEXT'], ['consent', 'BOOLEAN']]);

    // Two days on, the six who completed 89 days ago have crossed 90: invited.
    // The one who completed ten days ago is not.
    const at = new Date(Date.now() + 2 * DAY).toISOString();
    const swept = (await (await page.request.get(`/api/cron?job=surveys&at=${at}`)).json()).surveys;
    expect(swept.sent).toBe(6);
    const invited = await prisma.surveyInvitation.findMany({ where: { surveyId }, select: { userId: true } });
    expect(new Set(invited.map((i) => i.userId))).toEqual(new Set(menteeIds.slice(0, 6)));

    // Answers: four placed + one seeking with consent, one EMPLOYED_HERE without.
    const answer = (i: number, destination: string, consent: boolean) =>
      prisma.surveyResponse.create({
        data: {
          orgId,
          surveyId,
          respondentId: menteeIds[i],
          respondentRole: 'MENTEE',
          answers: { create: [{ questionKey: 'destination', value: destination }, { questionKey: 'consent', value: consent }] },
        },
      });
    await answer(0, 'EMPLOYED_ELSEWHERE', true);
    await answer(1, 'EMPLOYED_ELSEWHERE', true);
    await answer(2, 'EMPLOYED_HERE', true);
    await answer(3, 'CONTINUING_STUDY', true);
    await answer(4, 'SEEKING', true);
    await answer(5, 'EMPLOYED_HERE', false);

    const report = await (await page.request.get('/api/admin/analytics/outcomes')).json();
    expect(report.overall).toMatchObject({ eligible: 7, known: 5, withheld: 1 });
    expect(report.overall.knowledgeRate).toBeCloseTo(5 / 7);
    expect(report.overall.destinations).toMatchObject({ EMPLOYED_ELSEWHERE: 2, EMPLOYED_HERE: 1, CONTINUING_STUDY: 1, SEEKING: 1 });
    expect(report.overall.placedRate).toBeCloseTo(4 / 5);
    // Spring: five consented of six — at the floor, so the table shows. The
    // unassigned bucket has one person and no answer: its rate, nothing else.
    const spring = report.byCohort.find((b: { label: string | null }) => b.label === `Spring ${stamp}`);
    expect(spring).toMatchObject({ eligible: 6, known: 5 });
    expect(spring.destinations).not.toBeNull();
    const none = report.byCohort.find((b: { label: string | null }) => b.label === null);
    expect(none).toMatchObject({ eligible: 1, known: 0, destinations: null });

    // A later answer replaces an earlier one: mentee 4 found a job.
    await answer(4, 'EMPLOYED_ELSEWHERE', true);
    const later = await (await page.request.get('/api/admin/analytics/outcomes')).json();
    expect(later.overall.destinations).toMatchObject({ EMPLOYED_ELSEWHERE: 3, SEEKING: 0 });

    // Withdrawal: mentee 0's answers go; they are eligible and unknown again.
    const withdrawn = await page.request.delete(`/api/admin/analytics/outcomes?userId=${menteeIds[0]}`);
    expect((await withdrawn.json()).deleted).toBe(1);
    const after = await (await page.request.get('/api/admin/analytics/outcomes')).json();
    expect(after.overall).toMatchObject({ eligible: 7, known: 4, withheld: 1 });

    // A period with nobody in it reads as nobody, not as an error.
    const empty = await (await page.request.get('/api/admin/analytics/outcomes?from=2020-01-01&to=2020-12-31')).json();
    expect(empty.overall).toMatchObject({ eligible: 0, known: 0, knowledgeRate: null });
  });

  test('only an admin reads it', async ({ page }) => {
    await signInAsFreshUser(page, mentees[0], PW, '/portal');
    expect((await page.request.get('/api/admin/analytics/outcomes')).status()).toBe(403);
    expect((await page.request.post('/api/admin/analytics/outcomes', { data: {} })).status()).toBe(403);
    expect((await page.request.delete(`/api/admin/analytics/outcomes?userId=${menteeIds[0]}`)).status()).toBe(403);
  });
});
