import { test, expect } from '@playwright/test';

// Regression for #408: the landing CTA "Get Started" button (white on a blue
// gradient) must stay light/readable in dark mode. The global `.bg-white`
// retint used to turn it into dark-on-dark (unreadable), including on hover.
test('landing CTA "Get Started" button stays light in dark mode', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.documentElement.classList.add('dark'));

  // Two "Get Started" links exist (hero + CTA); the CTA one is last in the DOM.
  const cta = page.getByRole('link', { name: /get started/i }).last();
  await cta.scrollIntoViewIfNeeded();

  const bg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');

  await cta.hover();
  // The button animates via transition-colors; wait for it to settle before
  // sampling so we don't read a mid-transition value.
  await page.waitForTimeout(400);
  const hoverBg = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  // Must stay a light surface (readable with the blue-700 label), not the
  // global dark retint. Assert lightness rather than an exact shade.
  const [r, g, b] = hoverBg.match(/\d+/g)!.map(Number);
  expect(r >= 200 && g >= 200 && b >= 200).toBeTruthy();
});
