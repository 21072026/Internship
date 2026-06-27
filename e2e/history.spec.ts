import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('changing a stage records an entry in the status history', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  const menteeEmail = uniqueEmail('mentee');
  const password = 'HistPass123!';
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'History Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'History Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.goto(`/mentor/mentees/${relation.id}`);
    await expect(page.getByText(/Aşama Geçmişi/)).toBeVisible();

    // Change the stage
    await page.getByLabel('Pipeline aşaması').selectOption('INTERNSHIP_IN_PROGRESS_450');
    await page.waitForTimeout(1800);

    // History records the transition
    const entry = await prisma.statusChange.findFirst({ where: { relationId: relation.id } });
    expect(entry?.toStatus).toBe('INTERNSHIP_IN_PROGRESS_450');
    expect(entry?.fromStatus).toBe('APPLICATION_100');

    // And it shows in the UI timeline (scope to the history list, not the select options)
    await page.reload();
    await expect(page.getByText('Aşama Geçmişi (1)')).toBeVisible();
    const entryItem = page.locator('ol li').first();
    await expect(entryItem).toContainText('450 · Staj devam ediyor');
    await expect(entryItem).toContainText('100 · İlk temas');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
