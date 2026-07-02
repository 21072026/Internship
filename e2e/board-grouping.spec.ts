import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC I (#422) — the admin board groups the 13 stages into collapsible phases
// and flags overdue cards.
test('admin board groups stages into collapsible phases and flags overdue cards', async ({ page }) => {
  const adminEmail = uniqueEmail('bg-admin');
  const mentorEmail = uniqueEmail('bg-mentor');
  const menteeEmail = uniqueEmail('bg-mentee');
  const password = 'AdminPass123!';
  await seedUser(adminEmail, password, 'ADMIN', 'BG Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'BG Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'BG Zeynep Overdue');

  // A pre-internship stage with a deadline in the past → overdue badge.
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      pipelineStatus: 'APPLICATION_100',
      stageDeadline: new Date('2020-01-01T00:00:00Z'),
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/board');

    // The three phase headers are present (labels are exact span text).
    await expect(page.getByText('Pre-internship', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Internship', { exact: true })).toBeVisible();
    await expect(page.getByText('Outcome', { exact: true })).toBeVisible();
    const preHeader = page.getByRole('button', { name: /Pre-internship/i });

    // The overdue candidate card is shown with its badge.
    await expect(page.getByText('BG Zeynep Overdue')).toBeVisible();
    await expect(page.getByText(/overdue/i).first()).toBeVisible();

    // Collapsing the pre-internship phase hides its cards.
    await preHeader.click();
    await expect(page.getByText('BG Zeynep Overdue')).toBeHidden({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
