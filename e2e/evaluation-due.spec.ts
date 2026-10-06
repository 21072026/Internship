import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// Evaluation due dates and reminders (#1891). Its own org WITH ITS OWN
// PIPELINE — none of the built-in stage keys exist here, so a hardcoded key
// anywhere in the sweep would make this fail.
//   • two sweeps → one EvaluationDue row per relation and type;
//   • reminded on the due date and a week later, never a third time;
//   • the mentor writing the evaluation stops it at once; the mentee's own
//     review of the mentor does not;
//   • only the mentor is ever reminded; an old stage entry is not backfilled.

const PW = 'EvaluationDue123!';
const DAY = 24 * 60 * 60 * 1000;

test.describe('evaluation due dates', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('ed-admin');
  const mentor = uniqueEmail('ed-mentor');
  const mentees = ['a', 'b', 'c'].map((k) => uniqueEmail(`ed-mentee-${k}`));
  let orgId = '';
  let mentorId = '';
  const menteeIds: string[] = [];
  const relationIds: string[] = [];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `ED Org ${stamp}`, slug: `ed-${stamp}` } })).id;
    await prisma.pipelineStage.createMany({
      data: [
        { orgId, key: 'LEAD_IN', label: 'Lead in', order: 0 },
        { orgId, key: 'ON_THE_JOB', label: 'On the job', order: 1 },
        { orgId, key: 'WRAPPED_UP', label: 'Wrapped up', order: 2, isTerminal: true },
      ],
    });
    await seedUser(admin, PW, 'ADMIN', `ED Admin ${stamp}`, orgId);
    mentorId = (await seedUser(mentor, PW, 'MENTOR', `ED Mentor ${stamp}`, orgId)).id;
    for (const [i, email] of mentees.entries()) {
      const id = (await seedUser(email, PW, 'MENTEE', `ED Mentee ${'ABC'[i]} ${stamp}`, orgId)).id;
      menteeIds.push(id);
      relationIds.push((await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId: id, pipelineStatus: 'LEAD_IN' } })).id);
    }
  });

  test.afterAll(async () => {
    await prisma.emailLog.deleteMany({ where: { to: { in: [mentor, ...mentees] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.setting.deleteMany({ where: { orgId } });
    await prisma.pipelineStage.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('custom stages, one row per type, two reminders, stop on write', async ({ page }) => {
    // Nine sweeps and three sign-ins: well past the default budget on a cold server.
    test.slow();
    await signInAndSettle(page, admin, PW, '/admin');
    // A key the org does not have is refused — it would silently never fire.
    expect((await page.request.put('/api/admin/settings', { data: { evaluationInterimStage: 'INTERNSHIP_IN_PROGRESS_450' } })).status()).toBe(400);
    expect((await page.request.put('/api/admin/settings', { data: { evaluationInterimStage: 'ON_THE_JOB', evaluationInterimDays: '21', evaluationFinalStage: 'WRAPPED_UP' } })).status()).toBe(200);

    // A and B enter the configured stage now; C entered it 60 days ago (no backfill).
    for (const i of [0, 1]) await prisma.statusChange.create({ data: { relationId: relationIds[i], fromStatus: 'LEAD_IN', toStatus: 'ON_THE_JOB' } });
    await prisma.statusChange.create({ data: { relationId: relationIds[2], fromStatus: 'LEAD_IN', toStatus: 'ON_THE_JOB', createdAt: new Date(Date.now() - 60 * DAY) } });

    const sweep = async (offsetDays: number) =>
      (await (await page.request.get(`/api/cron?job=evaluations&at=${new Date(Date.now() + offsetDays * DAY).toISOString()}`)).json()).evaluations;
    expect(await sweep(0)).toMatchObject({ created: 2, reminded: 0 });
    expect(await sweep(0)).toMatchObject({ created: 0, reminded: 0 }); // the unique is the claim
    const rows = await prisma.evaluationDue.findMany({ where: { orgId } });
    expect(rows.map((r) => [r.relationId, r.type]).sort()).toEqual([[relationIds[0], 'INTERIM'], [relationIds[1], 'INTERIM']].sort());

    expect(await sweep(20)).toMatchObject({ reminded: 0 }); // due on day 21
    expect(await sweep(21)).toMatchObject({ reminded: 2 });
    expect(await sweep(21)).toMatchObject({ reminded: 0 });

    // B's mentor writes the interim evaluation; A's MENTEE reviews the mentor —
    // only the first is the task the reminder is about.
    await page.context().clearCookies();
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await page.request.post('/api/evaluations', { data: { relationId: relationIds[1], type: 'INTERIM', scores: { technical: 4 } } })).status()).toBe(201);
    expect((await prisma.evaluationDue.findFirstOrThrow({ where: { relationId: relationIds[1] } })).completedAt).not.toBeNull();
    await signInAsFreshUser(page, mentees[0], PW, '/portal');
    expect((await page.request.post('/api/evaluations', { data: { relationId: relationIds[0], type: 'INTERIM', scores: { communication: 5 } } })).status()).toBe(201);
    expect((await prisma.evaluationDue.findFirstOrThrow({ where: { relationId: relationIds[0] } })).completedAt).toBeNull();

    await page.context().clearCookies();
    await signInAndSettle(page, admin, PW, '/admin');
    expect(await sweep(27)).toMatchObject({ reminded: 0 }); // the second waits a week
    expect(await sweep(28)).toMatchObject({ reminded: 1 }); // A only — B was written
    expect(await sweep(60)).toMatchObject({ reminded: 0 }); // never a third
    expect((await prisma.evaluationDue.findFirstOrThrow({ where: { relationId: relationIds[0] } })).remindersSent).toBe(2);

    // Only the mentor was reminded — in-app and by mail; no mentee, ever.
    expect(await prisma.notification.count({ where: { userId: mentorId, type: 'evaluation.dueInterim' } })).toBe(3);
    expect(await prisma.notification.count({ where: { userId: { in: menteeIds }, type: { startsWith: 'evaluation.due' } } })).toBe(0);
    expect(await prisma.emailLog.count({ where: { to: mentor, category: 'goals-evaluation' } })).toBe(3);
    expect(await prisma.emailLog.count({ where: { to: { in: mentees }, category: 'goals-evaluation' } })).toBe(0);
  });

  test('an evaluation past its due date sits in the mentor\'s attention queue until it is written', async ({ page }) => {
    // A's interim row is already past due from the test above (or created here if run alone).
    await prisma.evaluationDue.upsert({
      where: { relationId_type: { relationId: relationIds[0], type: 'INTERIM' } },
      update: { dueAt: new Date(Date.now() - DAY), completedAt: null },
      create: { orgId, relationId: relationIds[0], type: 'INTERIM', dueAt: new Date(Date.now() - DAY) },
    });
    await signInAndSettle(page, mentor, PW, '/mentor');
    const queue = page.getByTestId('attention-queue');
    await expect(queue).toContainText(`ED Mentee A ${stamp}`);
    await expect(queue).toContainText('Evaluation due — write it');

    expect((await page.request.post('/api/evaluations', { data: { relationId: relationIds[0], type: 'INTERIM', scores: { technical: 3 } } })).status()).toBe(201);
    await page.reload();
    await expect(page.getByText('Evaluation due — write it')).toHaveCount(0);
  });
});
