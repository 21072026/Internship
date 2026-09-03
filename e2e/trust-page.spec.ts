import { test, expect, type Page } from '@playwright/test';

/**
 * /trust (#2027) — the public trust centre.
 *
 * What matters about this page is that it works for the reader it was built
 * for: a stranger doing a procurement review, signed out, possibly on a phone,
 * possibly reading in Turkish or German. So the assertions are: it renders
 * anonymously, the subprocessor register is actually a table with rows in it,
 * the two blocks a buyer looks for (residency, and the honest "not true yet"
 * list) are present, all three locales render, and 360px does not scroll
 * sideways.
 *
 * Deliberately NOT @smoke: the page is static server-rendered marketing/legal
 * copy with no database dependency, so it cannot break in a way the fast PR
 * gate needs to catch. Keeping the smoke set small is the point (CLAUDE.md).
 */

test.use({ storageState: { cookies: [], origins: [] } });

/**
 * Same trick as e2e/mobile-layout-audit.spec.ts: the locale cookie wins over any
 * user preference, and it needs an origin to be set on — hence a navigation
 * before setting it.
 */
async function setLocale(page: Page, locale: 'tr' | 'de') {
  await page.goto('/auth/signin');
  await page.evaluate((l) => { document.cookie = `locale=${l};path=/`; }, locale);
}

test('renders for a signed-out visitor', async ({ page }) => {
  await page.goto('/trust');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The four sections a procurement reader is here for.
  await expect(page.getByTestId('trust-posture')).toBeVisible();
  await expect(page.getByTestId('trust-controls')).toBeVisible();
  await expect(page.getByTestId('trust-residency')).toBeVisible();
  await expect(page.getByTestId('trust-docs')).toBeVisible();
});

test('publishes the subprocessor register as a table', async ({ page }) => {
  await page.goto('/trust');

  const table = page.getByTestId('subprocessor-table');
  await expect(table).toBeVisible();

  // Six columns, in the order the register declares them.
  await expect(table.locator('thead th')).toHaveCount(6);

  // Every row in src/lib/trust.ts renders. Named individually rather than by a
  // count, so adding a subprocessor without translating it fails loudly here
  // too, not only in tsc.
  for (const id of [
    'hosting', 'smtpPrimary', 'smtpBulk', 'anthropic', 'googleCalendar',
    'jaas', 'jitsiPublic', 'webPush', 'plausible', 'posthog', 'ga4', 'tawk', 'github',
  ]) {
    await expect(table.getByTestId(`subprocessor-row-${id}`)).toHaveCount(1);
  }
});

test('says out loud what is not true yet', async ({ page }) => {
  await page.goto('/trust');

  // The whole value of the page depends on this block surviving future edits.
  await expect(page.getByTestId('trust-limitations')).toBeVisible();
  await expect(page.getByTestId('trust-limitation-tenancy')).toBeVisible();
  await expect(page.getByTestId('trust-limitation-sharedHost')).toBeVisible();
});

test('is reachable from the public footer', async ({ page }) => {
  await page.goto('/privacy');

  const link = page.getByTestId('public-footer').locator('a[href="/trust"]');
  await expect(link).toHaveCount(1);

  // The footer label is read from t.trust.title, so it must equal the page's
  // own heading — that is the reason it is wired that way.
  const label = (await link.innerText()).trim();
  await page.goto('/trust');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(label);
});

for (const locale of ['tr', 'de'] as const) {
  test(`renders in ${locale}`, async ({ page }) => {
    await setLocale(page, locale);
    await page.goto('/trust');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('subprocessor-table')).toBeVisible();
    await expect(page.getByTestId('trust-limitations')).toBeVisible();

    // Translated, not the English fallback: the "not true yet" heading is the
    // one that must never silently drop back to English.
    const heading = await page.getByTestId('trust-limitations').locator('h2').innerText();
    expect(heading.toLowerCase()).not.toContain('what is not true yet');
  });
}

test('does not scroll sideways at 360px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/trust');
  await expect(page.getByTestId('subprocessor-table')).toBeVisible();

  // The register is far wider than a phone, so it scrolls inside its own box.
  // The document must not. A couple of pixels of rounding slack.
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(2);
});
