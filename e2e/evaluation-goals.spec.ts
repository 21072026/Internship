import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string, home: string) {
  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('two-way evaluations with interim/final type, and goal tracking', async ({ page }) => {
  const mentorEmail = uniqueEmail('eg-mentor');
  const menteeEmail = uniqueEmail('eg-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'EG Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'EG Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    // Mentor records a FINAL evaluation of the mentee and a goal.
    await signIn(page, mentorEmail, 'MentorPass123', '/mentor');
    const evalRes = await page.request.post('/api/evaluations', {
      data: { relationId: rel.id, type: 'FINAL', scores: { technical: 5, communication: 4 }, comment: 'Great work' },
    });
    expect(evalRes.status()).toBe(201);

    const goalRes = await page.request.post('/api/goals', { data: { relationId: rel.id, title: 'Ship the project' } });
    expect(goalRes.status()).toBe(201);
    const goalId = (await goalRes.json()).goal.id;
    const patched = await page.request.patch(`/api/goals/${goalId}`, { data: { status: 'DONE' } });
    expect(patched.ok()).toBeTruthy();

    // Mentee evaluates their mentor (two-way) using the mentor rubric.
    await signIn(page, menteeEmail, 'MenteePass123', '/portal');
    const menteeEval = await page.request.post('/api/evaluations', {
      data: { relationId: rel.id, type: 'INTERIM', scores: { guidance: 5, support: 5 } },
    });
    expect(menteeEval.status()).toBe(201);

    // Both evaluations are visible with correct direction + type.
    const list = await (await page.request.get(`/api/evaluations?relationId=${rel.id}`)).json();
    expect(list.evaluations.length).toBe(2);
    const onMentee = list.evaluations.find((e: { direction: string }) => e.direction === 'MENTOR_ON_MENTEE');
    const onMentor = list.evaluations.find((e: { direction: string }) => e.direction === 'MENTEE_ON_MENTOR');
    expect(onMentee.type).toBe('FINAL');
    expect(onMentor.scores.guidance).toBe(5);

    // The goal is marked done.
    const goals = await (await page.request.get(`/api/goals?relationId=${rel.id}`)).json();
    expect(goals.goals[0].status).toBe('DONE');
  } finally {
    await prisma.evaluation.deleteMany({ where: { relationId: rel.id } });
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
