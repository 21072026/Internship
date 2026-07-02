import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC B (#415): mentor rows are clickable and open a detail page showing the
// mentor's expertise, capacity and their active mentees.
test('mentor detail page shows expertise, capacity and active mentees', async ({ page }) => {
  const mentorEmail = uniqueEmail('md-mentor');
  const menteeEmail = uniqueEmail('md-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'MD Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'MD Mentee');
  await prisma.user.update({ where: { id: mentor.id }, data: { skills: ['Rust', 'Go'], mentorCapacity: 3 } });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto(`/admin/mentors/${mentor.id}`);

    // Expertise chips and the assigned mentee are shown.
    await expect(page.getByText('Rust', { exact: true })).toBeVisible();
    await expect(page.getByText('MD Mentee', { exact: true })).toBeVisible();
    // Capacity badge reflects 1/3.
    await expect(page.getByText(/1\/3/)).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
