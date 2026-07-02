import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #443 (B3): goals record which side created them, so the UI can show
// "Created by mentor/mentee".
test('a goal records its creator role', async ({ page }) => {
  const mentorEmail = uniqueEmail('goal-mentor');
  const menteeEmail = uniqueEmail('goal-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Goal Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Goal Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'Pass1234!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    const created = await page.request.post('/api/goals', {
      data: { relationId: rel.id, title: 'Finish the onboarding doc' },
    });
    expect(created.ok()).toBeTruthy();

    const list = await (await page.request.get(`/api/goals?relationId=${rel.id}`)).json();
    const goal = list.goals.find((g: { title: string }) => g.title === 'Finish the onboarding doc');
    expect(goal).toBeTruthy();
    expect(goal.createdByRole).toBe('MENTOR');
    expect(typeof goal.createdAt).toBe('string');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
