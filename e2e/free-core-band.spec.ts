import { test, expect } from '@playwright/test';

/**
 * #1732 — the landing free-core band: the one line answering "what does this
 * cost me" promoted out of the hero into a band of its own.
 *
 * This file is what remained of `pricing-nav.spec.ts` after the /pricing links
 * were parked (#2296). #2284 shipped the header, footer and band links to
 * `/pricing` before the page itself, and App Router prefetches every
 * in-viewport <Link>: the prefetch 404 reached the browser console, which
 * `smoke.spec.ts` treats as a failure, so main's whole merge gate went red.
 *
 * The links are back with the page (#1730), and their assertions live in
 * `e2e/pricing.spec.ts` rather than here — deliberately, because the lesson of
 * #2296 is that a nav test has to assert the DESTINATION rendered, not that a
 * click changed the URL. That belongs next to the page it renders. What stays
 * here is the band itself: its promise, its CTA and its behaviour on a phone.
 */

test('the landing free-core band states the promise', async ({ page }) => {
  await page.goto('/');

  const band = page.getByTestId('landing-free-core');
  // The headline is the shipped `landing.heroModel` sentence, promoted out of
  // the hero — asserting a fragment of it catches the band losing its point.
  await expect(band).toContainText('Free for mentees and mentors, always.');
  // Free core must never read as a trial or a seat count.
  await expect(band).toContainText('no seat count');
  // The CTA the band was built around (#1732), restored with the page it needs.
  // Asserting the href rather than clicking keeps this test about the band;
  // pricing.spec.ts is what proves the destination renders.
  await expect(band.getByTestId('free-core-cta')).toHaveAttribute('href', '/pricing');
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
