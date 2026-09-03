import { test, expect } from '@playwright/test';

// Click the three-state theme control (system → light → dark → system, #2078)
// until it lands on the wanted state. It polls instead of clicking a fixed
// number of times: the button is in the SSR markup with its initial
// `data-theme="system"` before React hydrates it, so both the attribute read
// and an early click can be stale/swallowed. Polling converges either way.
async function selectTheme(page: import('@playwright/test').Page, want: 'system' | 'light' | 'dark') {
  const toggle = page.getByTestId('theme-toggle').first();
  await expect(toggle).toBeVisible();
  await expect
    .poll(async () => {
      const current = await toggle.getAttribute('data-theme');
      if (current === want) return current;
      await toggle.click();
      return toggle.getAttribute('data-theme');
    }, { timeout: 15_000 })
    .toBe(want);
}

// Dark mode (EPIC D1). The toggle on the public landing header flips the
// `dark` class on <html>, persists a `theme` cookie, and survives reload.
test('theme toggle switches dark mode and persists across reload', async ({ page }) => {
  await page.goto('/');

  const html = page.locator('html');
  // Start from a known light baseline regardless of the runner's OS preference.
  await page.emulateMedia({ colorScheme: 'light' });
  await selectTheme(page, 'light');
  await expect(html).not.toHaveClass(/\bdark\b/);

  // Toggle → dark.
  await selectTheme(page, 'dark');
  await expect(html).toHaveClass(/\bdark\b/);

  // Cookie was written so SSR + the no-flash script agree on the next load.
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'theme')?.value).toBe('dark');

  // Survives a full reload (no flash back to light).
  await page.reload();
  await expect(html).toHaveClass(/\bdark\b/);

  // Toggle back → light.
  await selectTheme(page, 'light');
  await expect(html).not.toHaveClass(/\bdark\b/);
});

// The sticky landing header uses bg-white/80; in dark mode it must not stay a
// light bar (regression from the utility remap missing opacity variants).
test('dark mode retints the translucent landing header (not a light bar)', async ({ page }) => {
  await page.goto('/');
  await selectTheme(page, 'dark');
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
