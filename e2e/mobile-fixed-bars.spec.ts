import { test, expect, type Locator, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * #935 — the cookie banner is `fixed bottom-0` and used to paint over the end of
 * the page. On an iPhone 13 (390×664) it filled 40% of the viewport and covered
 * the "Create Account" button, so the very first action in the product could not
 * be completed without dismissing the banner first.
 *
 * These are geometric assertions (bounding boxes), not screenshots: scroll to the
 * bottom of the document and nothing may still be underneath the banner.
 */

// The banner only shows for a first-time visitor; every other spec starts from
// the pre-consented storage state.
test.use({ storageState: { cookies: [], origins: [] } });

const IPHONE_13 = { width: 390, height: 664 };

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function scrollToBottom(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  // Let the scroll settle before measuring.
  await page.waitForTimeout(150);
}

/** Asserts `target` sits entirely above the cookie banner. */
async function expectClearOfBanner(page: Page, target: Locator) {
  const banner = page.getByTestId('cookie-banner');
  await expect(banner).toBeVisible();
  await scrollToBottom(page);

  const bannerBox = await banner.boundingBox();
  const targetBox = await target.boundingBox();
  expect(bannerBox, 'banner has a box').not.toBeNull();
  expect(targetBox, 'target has a box').not.toBeNull();
  // 1px of slack: the reserved inset is the rounded-up banner height, so the two
  // edges meet exactly when the page is scrolled all the way down.
  expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(bannerBox!.y + 1);
}

test('mobile: the cookie banner never covers the register CTA', async ({ page }) => {
  await page.setViewportSize(IPHONE_13);
  await page.context().clearCookies();
  await page.goto('/auth/register');

  const cta = page.getByRole('button', { name: /Create Account/i });
  await expectClearOfBanner(page, cta);

  // Proof it is genuinely usable: a real click is not intercepted by the banner
  // (Playwright fails the click if another element is on top of it).
  await cta.click();
  await expect(page).toHaveURL(/\/auth\/register/);
});

test('mobile: the cookie banner never covers the sign-in CTA', async ({ page }) => {
  await page.setViewportSize(IPHONE_13);
  await page.context().clearCookies();
  await page.goto('/auth/signin');

  await expectClearOfBanner(page, page.locator('button[type="submit"]'));
});

test('mobile: the cookie banner never covers the end of the portal page', async ({ page }) => {
  const email = uniqueEmail('fixedbar-mentee');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Fixed Bar Mentee');

  try {
    await page.setViewportSize(IPHONE_13);
    await page.context().clearCookies();
    await signInAndSettle(page, email, 'MenteePass123', '/portal');

    // No page-specific button here — assert the invariant instead: the whole
    // content area scrolls clear of the banner, so nothing on the page is buried.
    await expectClearOfBanner(page, page.locator('main#main-content'));
  } finally {
    await cleanupByEmail(email);
  }
});

test('dismissing the banner leaves no leftover gap', async ({ page }) => {
  await page.setViewportSize(IPHONE_13);
  await page.context().clearCookies();
  await page.goto('/auth/register');

  const inset = () =>
    page.evaluate(() => getComputedStyle(document.body).paddingBottom);

  await expect(page.getByTestId('cookie-banner')).toBeVisible();
  expect(parseFloat(await inset())).toBeGreaterThan(0);

  await page.getByRole('button', { name: /Necessary only/i }).click();
  await expect(page.getByTestId('cookie-banner')).toHaveCount(0);
  await expect.poll(async () => parseFloat(await inset())).toBe(0);
});
