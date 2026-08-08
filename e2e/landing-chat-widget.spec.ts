import { test, expect, type Page } from '@playwright/test';
import { COOKIE_CONSENT_KEY, COOKIE_CONSENT_VERSION } from '../src/lib/cookieConsent';

// #1174 — the tawk.to live chat sits on the landing page only, behind the
// marketing consent gate. Both halves of that sentence are easy to break by
// accident (a component moved into the layout, a gate dropped "just to test
// something"), so they are asserted here.
//
// The third party itself is stubbed: the point is *whether* we reach for it,
// not what it sends back, and CI should not depend on tawk.to being up.
test.use({ storageState: { cookies: [], origins: [] } });

const TAWK_GLOB = '**embed.tawk.to/**';
const ACCEPT_ALL = /accept all|tümünü kabul et|alle akzeptieren/i;

/** Records every request to tawk.to and answers it with an empty script. */
async function stubTawk(page: Page): Promise<string[]> {
  const requests: string[] = [];
  await page.route(TAWK_GLOB, async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
  return requests;
}

/** Pre-seeds an "accept all" choice so the banner never shows. */
async function seedConsent(page: Page) {
  await page.addInitScript(([key, version]) => {
    localStorage.setItem(
      key as string,
      JSON.stringify({ version, necessary: true, analytics: true, marketing: true, ts: new Date().toISOString() }),
    );
  }, [COOKIE_CONSENT_KEY, COOKIE_CONSENT_VERSION] as const);
}

test('the chat loads only once marketing cookies are accepted', async ({ page }) => {
  const requests = await stubTawk(page);
  await page.context().clearCookies();
  await page.goto('/');

  const banner = page.getByRole('dialog', { name: /privacy/i });
  await expect(banner).toBeVisible({ timeout: 10_000 });

  // Before the choice: no embed, and nothing asked of tawk.to.
  await expect(page.locator('#tawk-to-embed')).toHaveCount(0);
  expect(requests).toEqual([]);

  await banner.getByRole('button', { name: ACCEPT_ALL }).click();
  await expect(banner).toBeHidden();

  // ...and it comes up on the spot, without a reload.
  await expect(page.locator('#tawk-to-embed')).toHaveCount(1);
  await expect.poll(() => requests.length).toBeGreaterThan(0);
});

test('declining leaves the chat off', async ({ page }) => {
  const requests = await stubTawk(page);
  await page.context().clearCookies();
  await page.goto('/');

  const banner = page.getByRole('dialog', { name: /privacy/i });
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await banner.getByRole('button', { name: /necessary only|sadece zorunlu|nur notwendige/i }).click();
  await expect(banner).toBeHidden();

  await expect(page.locator('#tawk-to-embed')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('the chat is on the landing page only, not the rest of the site', async ({ page }) => {
  const requests = await stubTawk(page);
  await page.context().clearCookies();
  await seedConsent(page);

  // Consent given, but these pages don't mount it.
  for (const path of ['/features', '/privacy', '/auth/signin']) {
    await page.goto(path);
    await expect(page.locator('#tawk-to-embed')).toHaveCount(0);
  }
  expect(requests).toEqual([]);

  // The landing page does.
  await page.goto('/');
  await expect(page.locator('#tawk-to-embed')).toHaveCount(1);
});
