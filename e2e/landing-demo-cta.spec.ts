import { test, expect } from '@playwright/test';

// The landing page must offer a path to the public demo (#966): a hero button,
// an inline link in the bottom CTA block, and a footer link. All three point at
// the demo host and are hidden on the demo instance itself (IS_DEMO_MODE) —
// these tests run against non-demo envs, so they assert presence.
const DEMO_URL = 'https://crm-demo.ersah.in';

test('the landing page links to the live demo (hero, CTA block, footer)', async ({ page }) => {
  await page.goto('/');

  const hero = page.getByTestId('hero-demo-cta');
  await expect(hero).toBeVisible();
  await expect(hero).toHaveAttribute('href', DEMO_URL);
  await expect(hero).toContainText('Try the live demo');

  const inline = page.getByTestId('cta-demo-link');
  await expect(inline).toHaveAttribute('href', DEMO_URL);

  // Footer link (labelled via publicNav.demo).
  await expect(page.locator(`footer a[href="${DEMO_URL}"]`)).toBeVisible();
});

test('the demo CTA is localized', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
  await page.reload();
  await expect(page.getByTestId('hero-demo-cta')).toContainText('Canlı demoyu deneyin');
});

// The quick-login panel is a demo-instance feature (#966): the server page
// passes the shared accounts only when DEMO_MODE=true, so on every other env
// (including this test run) the sign-in page must not render it.
test('the demo quick-login panel stays hidden off the demo instance', async ({ page }) => {
  await page.goto('/auth/signin');
  await expect(page.getByRole('heading')).toBeVisible();
  await expect(page.getByTestId('demo-quick-login')).toHaveCount(0);
});
