import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #476: page-title <h1> elements used a plain text-gray-900 with no dark:
// variant. Verify the fix renders a light color (not near-black) once dark
// mode is on, on both an admin page and a non-admin one.
test('page titles are readable in dark mode', async ({ page }) => {
  const email = uniqueEmail('darkhead-admin');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'Dark Head Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    for (const path of ['/admin/companies', '/admin/users']) {
      await page.goto(path);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      const [r, g, b] = (await page.locator('h1').first().evaluate((el) => getComputedStyle(el).color))
        .match(/\d+(\.\d+)?/g)!
        .map(Number);
      // Retinted h1 should be a light gray (~#f3f4f6), not the original near-black.
      expect(r).toBeGreaterThan(150);
      expect(g).toBeGreaterThan(150);
      expect(b).toBeGreaterThan(150);
    }
  } finally {
    await cleanupByEmail(email);
  }
});
