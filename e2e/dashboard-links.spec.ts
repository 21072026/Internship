import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('candidates can be filtered by pipeline stage via ?status=', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  const inEmail = uniqueEmail('in-stage');
  const outEmail = uniqueEmail('out-stage');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'DL Mentor');
  const inMentee = await seedUser(inEmail, 'Pass1234!', 'MENTEE', 'ZZ InStage Mentee');
  const outMentee = await seedUser(outEmail, 'Pass1234!', 'MENTEE', 'ZZ OutStage Mentee');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: inMentee.id, pipelineStatus: 'HIRED_660' },
  });
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: outMentee.id, pipelineStatus: 'JOB_SEEKING_500' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    // Dashboard stat card links to candidates
    await page.goto('/admin');
    await expect(page.locator('a[href="/admin/candidates"]').first()).toBeVisible();

    // Filtered candidate list (as the dashboard pipeline bar links)
    await page.goto('/admin/candidates?status=HIRED_660');
    await page.waitForTimeout(1200);
    await expect(page.getByText('660 · Hired')).toBeVisible(); // filter chip
    await expect(page.getByText('ZZ InStage Mentee')).toBeVisible();
    await expect(page.getByText('ZZ OutStage Mentee')).toHaveCount(0);

    // Name links to the detail page
    await page.getByRole('link', { name: 'ZZ InStage Mentee' }).click();
    await page.waitForURL((u) => u.pathname.includes(`/admin/candidates/${inMentee.id}`), { timeout: 15_000 });
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(inEmail);
    await cleanupByEmail(outEmail);
  }
});
