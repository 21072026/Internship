import type { Page } from '@playwright/test';

/**
 * Sign in through the UI and wait until the post-login redirect chain has
 * actually settled.
 *
 * WHY THIS EXISTS: `page.waitForURL()` resolves the moment the URL matches, which
 * can be *before* the sign-in page's push to the role landing page has finished
 * committing. A deep-link `page.goto()` issued in that window is aborted by
 * Playwright with:
 *
 *   page.goto: Navigation to "/admin/organizations" is interrupted by
 *   another navigation to "/admin"
 *
 * That killed admin-organizations, company-shortlist and message-attachments in
 * the scheduled full run. Waiting for the network to go quiet lets the landing
 * navigation finish first.
 */
export async function signInAndSettle(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

/**
 * `page.goto()` that tolerates losing a race with an in-flight client-side
 * navigation. `signInAndSettle` should make this unnecessary, but the redirect
 * is driven by React state we don't control, so retrying once is cheaper than a
 * flaky scheduled run. Only the specific "interrupted" error is retried —
 * anything else propagates untouched.
 */
export async function gotoSettled(page: Page, url: string) {
  try {
    await page.goto(url);
  } catch (error) {
    if (!/interrupted by another navigation/i.test(String(error))) throw error;
    await page.waitForLoadState('networkidle');
    await page.goto(url);
  }
}
