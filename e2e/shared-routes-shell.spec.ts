import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, acceptContributorTerms } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('shared cross-role routes preserve the mentee portal sidebar', async ({ page }) => {
  const menteeEmail = uniqueEmail('shared-shell-mentee');
  const pw = 'SharedShell123!';
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Shared Shell Mentee');
  await acceptContributorTerms(mentee.id);

  try {
    // 1. Sign in as Mentee
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // 2. Sub-portal route (/portal) has sidebar
    await expect(page.locator('aside')).toBeVisible({ timeout: 10_000 });

    // 3. /todos preserves sidebar
    await page.goto('/todos');
    await expect(page.locator('aside')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: /Yapılacaklar|To-dos|Aufgaben/i })).toBeVisible({ timeout: 10_000 });

    // 4. /mentors preserves sidebar
    await page.goto('/mentors');
    await expect(page.locator('aside')).toBeVisible({ timeout: 10_000 });

    // 5. /newsletters preserves sidebar
    await page.goto('/newsletters');
    await expect(page.locator('aside')).toBeVisible({ timeout: 10_000 });

    // 6. /messages preserves sidebar
    await page.goto('/messages');
    await expect(page.locator('aside')).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});
