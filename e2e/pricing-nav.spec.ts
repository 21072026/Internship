import { test, expect } from '@playwright/test';

/**
 * #1732 — the price has to be one click from anywhere on the marketing site.
 *
 * The public chrome offered Features / For companies / Showcase and never
 * mentioned money, so a visitor who came for the number had nothing to click.
 * This guards the three routes to it: the desktop header, the phone menu and
 * the footer's Product column — plus the free-core band on the landing page,
 * whose only CTA is /pricing.
 *
 * These assert the *route*, not the destination page's content: `/pricing`
 * itself ships in #1730, and a nav link is a separate regression surface from
 * whatever that page ends up saying. `e2e/pricing.spec.ts` covers the page.
 */

test('the header links pricing from the landing page', async ({ page }) => {
  await page.goto('/');

  const header = page.getByTestId('public-header');
  const link = header.getByRole('link', { name: 'Pricing', exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/pricing');

  await link.click();
  await expect(page).toHaveURL(/\/pricing$/);
});

test('the footer Product column links pricing', async ({ page }) => {
  // A visitor who scrolled past the band looks for the price in the footer,
  // and it belongs in Product rather than Legal.
  await page.goto('/features');

  const footer = page.getByTestId('public-footer');
  const link = footer.getByRole('link', { name: 'Pricing', exact: true });
  await expect(link).toHaveAttribute('href', '/pricing');
  await link.click();
  await expect(page).toHaveURL(/\/pricing$/);
});

test('the landing free-core band states the promise and links pricing', async ({ page }) => {
  await page.goto('/');

  const band = page.getByTestId('landing-free-core');
  // The headline is the shipped `landing.heroModel` sentence, promoted out of
  // the hero — asserting a fragment of it catches the band losing its point.
  await expect(band).toContainText('Free for mentees and mentors, always.');
  // Free core must never read as a trial or a seat count.
  await expect(band).toContainText('no seat count');

  const cta = page.getByTestId('free-core-pricing-cta');
  await expect(cta).toHaveAttribute('href', '/pricing');
  await cta.click();
  await expect(page).toHaveURL(/\/pricing$/);
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the collapsed nav menu reaches pricing too', async ({ page }) => {
    // The header's `links` array drives both the `lg` bar and this panel, so
    // the failure mode is a link added to a hand-rolled desktop-only list.
    await page.goto('/');

    await page.getByTestId('public-nav-toggle').click();
    const menu = page.getByTestId('public-nav-mobile');
    await expect(menu).toBeVisible();

    const link = menu.getByRole('link', { name: 'Pricing', exact: true });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/pricing$/);
  });

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
