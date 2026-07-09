import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin assigns an unassigned candidate to themselves from the Candidates screen', async ({ page }) => {
  const adminEmail = uniqueEmail('assign-admin');
  const menteeEmail = uniqueEmail('assign-mentee');
  const pw = 'AssignPass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Assign Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Assign Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/candidates');
    // Narrow to just this candidate.
    await page.getByPlaceholder('Search by name, email, university...').fill(menteeEmail);

    const card = page.getByTestId(`candidate-card-${mentee.id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    const done = page.waitForResponse(
      (r) => r.url().includes('/api/mentorship') && r.request().method() === 'POST',
      { timeout: 20_000 }
    );
    await card.getByRole('button', { name: 'Assign to me' }).click();
    const res = await done;
    expect(res.ok()).toBeTruthy();

    // A relation now exists with this admin as mentor.
    await expect
      .poll(async () => prisma.mentorshipRelation.count({ where: { menteeId: mentee.id, mentorId: admin.id } }), { timeout: 10_000 })
      .toBe(1);
  } finally {
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
  }
});
