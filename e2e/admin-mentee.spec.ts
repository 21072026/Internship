import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can open a mentee detail page with profile + mentorship', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  const menteeEmail = uniqueEmail('mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Detail Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Detail Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { city: 'Köln', university: 'TU' } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByRole('heading', { name: 'Detail Mentee' })).toBeVisible();
    await expect(page.getByText('Köln')).toBeVisible();
    await expect(page.getByText('Detail Mentor')).toBeVisible();
    await expect(page.getByText('450 · Staj devam ediyor').first()).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
