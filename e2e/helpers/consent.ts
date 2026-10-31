import type { Page } from '@playwright/test';

/**
 * Dismiss the cookie banner — only when it can actually be there.
 *
 * Every context starts from `e2e/.state/consent.json` (global-setup), which
 * stores the consent in localStorage, so the banner never renders. Specs used
 * to "dismiss" it with `click().catch(() => {})` anyway, and a click on a
 * button that never appears waits the whole `actionTimeout` (15 s) before the
 * catch swallows it: the slowest @smoke test spent 15 of its 15.5 s there.
 * Read the stored consent instead: present → nothing to do, at once; absent
 * (a fresh context, cleared storage) → the banner is coming, so click it for
 * real and let a missing banner fail loudly.
 *
 * Call it after `page.goto()` — localStorage belongs to the page's origin.
 */
export async function dismissConsentBanner(page: Page) {
  const consented = await page
    .evaluate(() => {
      try {
        return localStorage.getItem('cookie_consent') !== null;
      } catch {
        return false;
      }
    })
    .catch(() => false);
  if (consented) return;
  await page.getByRole('button', { name: /Necessary only/i }).click();
}
