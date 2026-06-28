import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin deactivates a user and that user can no longer sign in', async ({ page }) => {
  const adminEmail = uniqueEmail('actadmin');
  const mentorEmail = uniqueEmail('actmentor');
  const mentorPw = 'MentorPass123!';
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Active Admin');
  const mentor = await seedUser(mentorEmail, mentorPw, 'MENTOR', 'Toggle Mentor');

  try {
    // Admin signs in and opens the Users page.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    // Deactivate the seeded mentor via its row.
    const row = page.getByTestId(`user-row-${mentor.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    const patched = page.waitForResponse(
      (r) => r.url().includes(`/api/users/${mentor.id}`) && r.request().method() === 'PATCH'
    );
    await row.getByRole('button', { name: 'Deactivate' }).click();
    await patched;

    const updated = await prisma.user.findUnique({ where: { id: mentor.id } });
    expect(updated!.isActive).toBe(false);

    // The deactivated mentor cannot sign in.
    await page.context().clearCookies();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', mentorPw);
    await page.click('button[type="submit"]');
    await expect(page.getByText(/deactivated/i)).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).pathname).toContain('/auth/signin');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
