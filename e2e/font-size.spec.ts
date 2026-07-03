import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Global font-size preference: a stepper in the account menu scales the whole
// app (via a class on <html>, same approach as the dark-mode toggle) and
// persists across reload.
test('font-size stepper scales the app and persists across reload', async ({ page }) => {
  const email = uniqueEmail('fontsize');
  await seedUser(email, 'Pass1234!', 'MENTEE', 'FontSize Tester');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'Pass1234!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    const html = page.locator('html');
    await expect(html).not.toHaveClass(/font-(sm|lg|xl)/);

    await page.locator('button[aria-haspopup="menu"]').click();
    const increase = page.getByRole('button', { name: /increase font size/i });
    const decrease = page.getByRole('button', { name: /decrease font size/i });

    // md -> lg -> xl.
    await increase.click();
    await expect(html).toHaveClass(/\bfont-lg\b/);
    await increase.click();
    await expect(html).toHaveClass(/\bfont-xl\b/);

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'fontSize')?.value).toBe('xl');

    // Actually scales the root font-size, not just a cosmetic class.
    const size = await html.evaluate((el) => getComputedStyle(el).fontSize);
    expect(parseFloat(size)).toBeGreaterThan(16);

    // Survives a full reload (no flash back to the default size).
    await page.reload();
    await expect(html).toHaveClass(/\bfont-xl\b/);

    // xl -> lg -> md (back to no font-* class).
    await page.locator('button[aria-haspopup="menu"]').click();
    await decrease.click();
    await expect(html).toHaveClass(/\bfont-lg\b/);
    await decrease.click();
    await expect(html).not.toHaveClass(/font-(sm|lg|xl)/);
  } finally {
    await cleanupByEmail(email);
  }
});
