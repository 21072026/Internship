import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin dashboard shows the pipeline distribution', async ({ page }) => {
  // Ensure at least one relation exists at a known stage
  const mentorEmail = uniqueEmail('mentor');
  const menteeEmail = uniqueEmail('mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Dash Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Dash Mentee');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/admin');
    // The route-level loading.tsx (#499) makes /admin stream: content briefly
    // exists in a hidden segment before React swaps it into place, so an
    // unscoped getByText can hit a hidden duplicate mid-stream (strict-mode
    // violation). Match visible nodes only.
    await expect(page.getByText('Mentees per stage').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('450 · Internship in progress').filter({ visible: true }).first()).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
