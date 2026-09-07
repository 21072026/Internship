import { test, expect } from '@playwright/test';

/**
 * #1732 — the landing free-core band: the one line answering "what does this
 * cost me" promoted out of the hero into a band of its own.
 *
 * This file is what remains of `pricing-nav.spec.ts` after the /pricing links
 * were parked. #2284 shipped the header, footer and band links to `/pricing`
 * before the page itself (#1730, still open), and App Router prefetches every
 * in-viewport <Link>: the prefetch 404 reached the browser console, which
 * `smoke.spec.ts` treats as a failure, so main's whole merge gate went red.
 *
 * The nav assertions come back with #1730 — restore them from this file's
 * history alongside the header/footer entries and the band CTA.
 */

test('the landing free-core band states the promise', async ({ page }) => {
  await page.goto('/');

  const band = page.getByTestId('landing-free-core');
  // The headline is the shipped `landing.heroModel` sentence, promoted out of
  // the hero — asserting a fragment of it catches the band losing its point.
  await expect(band).toContainText('Free for mentees and mentors, always.');
  // Free core must never read as a trial or a seat count.
  await expect(band).toContainText('no seat count');
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the landing free-core band does not overflow a 375px screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('landing-free-core')).toBeVisible();
    const overflow = await page.evaluate(
      // 1px of slack for sub-pixel rounding, as in public-chrome.spec.ts.
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
