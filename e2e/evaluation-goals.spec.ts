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
    await prisma.goal.createMany({
      data: [
        { relationId: rel.id, title: 'Older active goal', createdAt: new Date('2026-01-01T00:00:00Z') },
        { relationId: rel.id, title: 'Newer active goal', createdAt: new Date('2026-02-01T00:00:00Z') },
      ],
    });

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
    expect(goals.goals.find((goal: { id: string }) => goal.id === goalId).status).toBe('DONE');

    // Completed goals live in the archive, while active goals can be sorted.
    await page.goto('/portal');
    const activeGoals = page.getByTestId('active-goals').locator('[data-testid^="goal-"]');
    await expect(activeGoals).toHaveCount(2);
    await expect(page.getByText('0/2 completed')).toBeVisible();
    await expect(page.getByText('0/2 completed').locator('..').getByText('0%', { exact: true })).toBeVisible();
    await expect(activeGoals.nth(0)).toContainText('Newer active goal');
    await expect(page.getByTestId('active-goals').getByText('Ship the project')).toHaveCount(0);
    await expect(page.getByTestId('goals-archive')).toHaveCount(0);

    await page.getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByTestId('goals-archive').getByText('Ship the project')).toBeVisible();

    await page.getByLabel('Sort by').selectOption('oldest');
    await expect(activeGoals.nth(0)).toContainText('Older active goal');

    const olderGoal = activeGoals.nth(0);
    await olderGoal.getByRole('button', { name: 'Edit' }).click();
    await olderGoal.getByLabel('Goal').fill('Updated active goal');
    await olderGoal.getByRole('button', { name: 'Save' }).click();
    await expect(olderGoal).toContainText('Updated active goal');
  } finally {
    await prisma.evaluation.deleteMany({ where: { relationId: rel.id } });
    await prisma.goal.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
