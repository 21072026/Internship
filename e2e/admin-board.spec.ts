import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin board shows every mentor\'s mentees grouped by stage', async ({ page }) => {
  const adminEmail = uniqueEmail('bdadmin');
  const mentorEmail = uniqueEmail('bdmentor');
  const menteeEmail = uniqueEmail('bdmentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Board Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Listed Board Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Board Admin Mentee');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.getByRole('link', { name: 'Board', exact: true }).click();
    await page.waitForURL((u) => u.pathname.includes('/admin/board'), { timeout: 15_000 });

    // The mentee card sits in the "450 · Internship in progress" column and
    // shows the owning mentor's name (admin sees all mentors).
    const column = page.locator('div.w-64', { hasText: '450 · Internship in progress' });
    await expect(column.getByText('Board Admin Mentee')).toBeVisible();
    await expect(column.getByText('Listed Board Mentor')).toBeVisible();
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
