import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// The program journey sweep (#1852). Its own org WITH ITS OWN PIPELINE, so a
// step anchored on a built-in stage key has nothing to match and must say so.
//   • a "start + 42 days" step fires once for a pair that started 42 days ago;
//   • a second sweep the same day delivers nothing (the unique is the claim);
//   • a pair that started long ago is not back-fired — no row at all;
//   • a step whose condition already holds is recorded skipped with its reason.

const PW = 'ProgramJourney123!';
const DAY = 24 * 60 * 60 * 1000;

test.describe('program journey', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('pj-admin');
  const mentor = uniqueEmail('pj-mentor');
  const mentees = ['a', 'b', 'c'].map((k) => uniqueEmail(`pj-mentee-${k}`));
  let orgId = '';
  let programId = '';
  const menteeIds: string[] = [];
  const relationIds: string[] = [];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `PJ Org ${stamp}`, slug: `pj-${stamp}` } })).id;
    await prisma.pipelineStage.createMany({
      data: [
        { orgId, key: 'LEAD_IN', label: 'Lead in', order: 0 },
        { orgId, key: 'ON_THE_JOB', label: 'On the job', order: 1 },
      ],
    });
    programId = (await prisma.cohort.create({ data: { orgId, name: `PJ Programme ${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `PJ Admin ${stamp}`, orgId);
    const mentorId = (await seedUser(mentor, PW, 'MENTOR', `PJ Mentor ${stamp}`, orgId)).id;
    // A and C started 42 days ago, B 200 days ago.
    const startedDaysAgo = [42, 200, 42];
    for (const [i, email] of mentees.entries()) {
      const id = (await seedUser(email, PW, 'MENTEE', `PJ Mentee ${'ABC'[i]} ${stamp}`, orgId)).id;
      menteeIds.push(id);
      const startDate = new Date(Date.now() - startedDaysAgo[i] * DAY - 60_000);
      relationIds.push((await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId: id, cohortId: programId, pipelineStatus: 'LEAD_IN', startDate } })).id);
    }
    // C already has a goal, so the "set your first goal" to-do is satisfied.
    await prisma.goal.create({ data: { relationId: relationIds[2], title: 'Already on it' } });
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: menteeIds } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.programStep.deleteMany({ where: { orgId } });
    await prisma.cohort.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.pipelineStage.deleteMany({ where: { orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('a day-42 step fires once, old pairs are not back-fired, satisfied steps are skipped', async ({ page }) => {
    const publishedAt = new Date();
    const nudge = await prisma.programStep.create({
      data: { orgId, programId, order: 1, anchor: 'RELATION_START', offsetDays: 42, audience: 'BOTH', action: 'NUDGE', title: 'Week 6 check-in', translations: { tr: '6. hafta görüşmesi' }, publishedAt },
    });
    const todo = await prisma.programStep.create({
      data: { orgId, programId, order: 2, anchor: 'RELATION_START', offsetDays: 42, audience: 'MENTEE', action: 'ASSIGN_TODO', title: 'Set your first goal', payload: { skipIf: 'goal_exists' }, publishedAt },
    });
    // Anchored on a built-in key this org's pipeline does not have.
    const builtIn = await prisma.programStep.create({
      data: { orgId, programId, order: 3, anchor: 'STAGE_ENTRY', offsetDays: 0, audience: 'MENTOR', action: 'NUDGE', title: 'Internship started', payload: { stageKey: 'INTERNSHIP_IN_PROGRESS_450' }, publishedAt },
    });
    // A draft is never delivered.
    await prisma.programStep.create({
      data: { orgId, programId, order: 4, anchor: 'RELATION_START', offsetDays: 42, audience: 'BOTH', action: 'NUDGE', title: 'Draft step' },
    });

    await signInAndSettle(page, admin, PW, '/admin');
    const sweep = async () => (await (await page.request.get('/api/cron?job=program-journey')).json()).programJourney;

    const first = await sweep();
    // nudge → A and C; to-do → A delivered, C skipped (it already has a goal).
    expect(first).toMatchObject({ delivered: 3, skipped: 1 });
    expect(first.unresolved).toEqual([{ stepId: builtIn.id, reason: 'stage_not_in_pipeline' }]);
    // Twice on the same day: nothing new.
    expect(await sweep()).toMatchObject({ delivered: 0, skipped: 0 });

    const runs = await prisma.programStepRun.findMany({ where: { step: { orgId } } });
    expect(runs).toHaveLength(4);
    const runOf = (stepId: string, rel: number) => runs.find((r) => r.stepId === stepId && r.relationId === relationIds[rel]);
    expect(runOf(nudge.id, 0)?.deliveredAt).not.toBeNull();
    expect(runOf(todo.id, 0)?.deliveredAt).not.toBeNull();
    expect(runOf(todo.id, 2)).toMatchObject({ deliveredAt: null, skippedReason: 'satisfied:goal_exists' });
    // B started 200 days ago: no row at all, nothing sent.
    expect(runs.filter((r) => r.relationId === relationIds[1])).toHaveLength(0);

    // The to-do is a goal of A's pair, and A's mentee was told once per step.
    expect(await prisma.goal.count({ where: { relationId: relationIds[0], title: 'Set your first goal' } })).toBe(1);
    const notes = await prisma.notification.findMany({ where: { userId: menteeIds[0] }, select: { type: true } });
    expect(notes.map((n) => n.type).sort()).toEqual(['programStep.nudge', 'programStep.todo']);
    expect(await prisma.notification.count({ where: { userId: menteeIds[1], type: { startsWith: 'programStep.' } } })).toBe(0);
  });
});
