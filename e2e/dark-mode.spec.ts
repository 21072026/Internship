import { test, expect } from '@playwright/test';

// Dark mode (EPIC D1). The toggle on the public landing header flips the
// `dark` class on <html>, persists a `theme` cookie, and survives reload.
test('theme toggle switches dark mode and persists across reload', async ({ page }) => {
  await page.goto('/');

  const html = page.locator('html');
  // Start from a known light baseline regardless of the runner's OS preference.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark');
    document.cookie = 'theme=light; path=/; max-age=0';
    try { localStorage.removeItem('theme'); } catch { /* ignore */ }
  });
  await expect(html).not.toHaveClass(/\bdark\b/);

  // Toggle → dark.
  const toggle = page.getByRole('button', { name: /toggle theme/i }).first();
  await toggle.click();
  await expect(html).toHaveClass(/\bdark\b/);

  // Cookie was written so SSR + the no-flash script agree on the next load.
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'theme')?.value).toBe('dark');

  // Survives a full reload (no flash back to light).
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);

  // Toggle back → light.
  await page.getByRole('button', { name: /toggle theme/i }).first().click();
  await expect(html).not.toHaveClass(/\bdark\b/);
});

// The sticky landing header uses bg-white/80; in dark mode it must not stay a
// light bar (regression from the utility remap missing opacity variants).
test('dark mode retints the translucent landing header (not a light bar)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /toggle theme/i }).first().click();
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);

  const headerBg = await page.locator('header').first().evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  // Parse "rgb(a)(r, g, b[, a])" and assert it is a dark surface, not near-white.
  const [r, g, b] = headerBg.match(/\d+(\.\d+)?/g)!.map(Number);
  expect(r).toBeLessThan(60);
  expect(g).toBeLessThan(60);
  expect(b).toBeLessThan(70);
});
