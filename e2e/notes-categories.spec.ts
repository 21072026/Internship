import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Betül feedback B10: personal notes now have a dedicated sidebar page and
// support categories (Meeting Notes / Feedback / Tasks / Personal Notes).
test('personal notes have a dedicated page and can be categorized/filtered', async ({ page }) => {
  const email = uniqueEmail('notecat-mentee');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'NoteCat Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Reachable from the sidebar as its own page, not just embedded on the dashboard.
    await page.getByRole('link', { name: 'My notes' }).click();
    await page.waitForURL((u) => u.pathname === '/portal/notes', { timeout: 10_000 });

    const picker = page.getByTestId('note-category-picker');
    const filter = page.getByTestId('note-category-filter');

    // Add a Tasks-category note (default category is Personal Notes).
    await page.locator('textarea').fill('Follow up on the pending internship offer');
    await picker.getByRole('button', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: 'Add note' }).click();
    const taskNote = page.getByText('Follow up on the pending internship offer');
    await expect(taskNote).toBeVisible({ timeout: 10_000 });
    await expect(taskNote.locator('xpath=..').getByText('Tasks', { exact: true })).toBeVisible();

    // Add a second, Personal-category note (picker resets to default after each add).
    await page.locator('textarea').fill('Remember to update my CV');
    await page.getByRole('button', { name: 'Add note' }).click();
    const personalNote = page.getByText('Remember to update my CV');
    await expect(personalNote).toBeVisible({ timeout: 10_000 });

    // Filtering by Tasks hides the Personal note.
    await filter.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(taskNote).toBeVisible();
    await expect(personalNote).toHaveCount(0);
  } finally {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) await prisma.personalNote.deleteMany({ where: { userId: user.id } });
    await cleanupByEmail(email);
  }
});
