import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * #1197 — every public page wears the same header and footer.
 *
 * Before this, each page carried its own chrome (or none): the landing had the
 * full nav, /features an icon strip, /for-companies a third variant, the legal
 * pages nothing at all. The regression this guards against is a new public page
 * being added — or an old one edited — without the shared shell, which is how
 * the drift happened the first time.
 */

// Every public page reachable from the landing.
const PUBLIC_PAGES = [
  '/',
  '/features',
  '/for-companies',
  '/apply-as-mentor',
  '/projects',
  '/release-notes',
  '/privacy',
  '/terms',
  '/imprint',
  '/code-of-conduct',
];

test.use({ storageState: { cookies: [], origins: [] } });

/** Dismisses the cookie banner if it is up, so it can't sit over the footer. */
async function dismissConsent(page: Page) {
  await page
    .getByRole('button', { name: /necessary only|yalnızca gerekli|nur notwendige/i })
    .click({ timeout: 2000 })
    .catch(() => {});
}

for (const path of PUBLIC_PAGES) {
  test(`${path} carries the shared public chrome`, async ({ page }) => {
    await page.goto(path);

    await expect(page.getByTestId('public-header')).toBeVisible();
    await expect(page.getByTestId('public-footer')).toBeAttached();

    // The skip-to-content link in the root layout points at #main-content. Public
    // pages had no such anchor, so it led nowhere for keyboard users.
    await expect(page.locator('#main-content')).toBeAttached();

    // The wordmark is a link to the home page on every page — including the home
    // page itself, where it used to be an inert <div>.
    const home = page.getByTestId('public-home-link');
    await expect(home).toBeVisible();
    await expect(home).toHaveAttribute('href', '/');
  });
}

test('the landing wordmark actually navigates home from a sub-page', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/terms');
  await dismissConsent(page);
  await page.getByTestId('public-home-link').click();
  await expect(page).toHaveURL(new RegExp(`${'\\/'}?$`));
  await expect(page.getByRole('heading', { name: /Companies that want experience/i })).toBeVisible();
});

test('the footer links the legal pages to each other', async ({ page }) => {
  // A visitor landing on /privacy from a search result used to have no route
  // anywhere except "back to home".
  await page.goto('/privacy');
  await dismissConsent(page);
  const footer = page.getByTestId('public-footer');
  await footer.getByRole('link', { name: 'Terms of Service' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole('heading', { name: 'Terms of Service', level: 1 })).toBeVisible();
});

test('the company page keeps its register button out of the chrome', async ({ page }) => {
  // Companies have no self-service sign-up (#1102/#1104) — the shared header
  // takes showRegister={false} there, and must not smuggle one back in.
  await page.goto('/for-companies');
  await expect(page.getByTestId('public-header').getByRole('link', { name: /^Register$/ })).toHaveCount(0);
  // …while every other public page does offer it.
  await page.goto('/features');
  await expect(page.getByTestId('public-header').getByRole('link', { name: /^Register$/ })).toBeVisible();
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the nav collapses into a menu that reaches every page', { tag: '@smoke' }, async ({ page }) => {
    await page.goto('/');
    await dismissConsent(page);

    // The old header hid "Features" and "For companies" under sm:/md: with no
    // menu behind them — on a phone those pages were unreachable from the header.
    const toggle = page.getByTestId('public-nav-toggle');
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId('public-nav-mobile')).toHaveCount(0);

    await toggle.click();
    const menu = page.getByTestId('public-nav-mobile');
    await expect(menu).toBeVisible();
    for (const name of [/Features/, /For companies/, /Project showcase/, /Sign In/]) {
      await expect(menu.getByRole('link', { name })).toBeVisible();
    }

    await menu.getByRole('link', { name: /For companies/ }).click();
    await expect(page).toHaveURL(/\/for-companies$/);
    // Navigating closes it, rather than leaving the panel over the new page.
    await expect(page.getByTestId('public-nav-mobile')).toHaveCount(0);
  });

  test('Escape closes the menu', async ({ page }) => {
    await page.goto('/');
    await dismissConsent(page);
    await page.getByTestId('public-nav-toggle').click();
    await expect(page.getByTestId('public-nav-mobile')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('public-nav-mobile')).toHaveCount(0);
  });

  test('no public page scrolls sideways on a phone', async ({ page }) => {
    for (const path of PUBLIC_PAGES) {
      await page.goto(path);
      const overflow = await page.evaluate(
        // 1px of slack for sub-pixel rounding, as in mobile-responsive.spec.ts.
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} at 390px`).toBeLessThanOrEqual(1);
    }
  });
});

// #1203 — the public chrome must not tell a signed-in user they are signed out.
//
// These pages are public but not only for the public: /release-notes is reached
// from the sidebar version footer, /privacy and /terms from consent screens.
// When they gained the shared chrome (#1197) it was hardcoded signed-out, so
// following any of those links replaced the app nav with "Sign In / Register" —
// which reads as having been logged out mid-session.
test.describe('signed in', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('the public chrome shows the dashboard, not Sign In', { tag: '@smoke' }, async ({ page }) => {
    const email = uniqueEmail('chrome-session');
    const password = 'ChromePass123!';
    await seedUser(email, password, 'MENTEE', 'Chrome Session Mentee');

    try {
      await signInAndSettle(page, email, password, '/portal');

      for (const path of ['/release-notes', '/privacy', '/terms', '/features']) {
        await page.goto(path);
        const header = page.getByTestId('public-header');
        // The tell: a signed-in visitor was being offered sign-in and sign-up.
        await expect(header.getByRole('link', { name: /^Sign In$/ }), `${path} offers Sign In`).toHaveCount(0);
        await expect(header.getByRole('link', { name: /^Register$/ }), `${path} offers Register`).toHaveCount(0);
        // …and gets a way back into the app instead.
        const dash = page.getByTestId('public-dashboard-link');
        await expect(dash, `${path} has no dashboard link`).toBeVisible();
        await expect(dash).toHaveAttribute('href', '/portal');
      }

      // It really goes back into the app.
      await page.getByTestId('public-dashboard-link').click();
      await expect(page).toHaveURL(/\/portal$/);
    } finally {
      await cleanupByEmail(email);
    }
  });
});
