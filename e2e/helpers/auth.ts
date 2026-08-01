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
 * Sign in as a *different* user than the one currently signed in.
 *
 * WHY THIS EXISTS: `clearCookies()` immediately before `goto('/auth/signin')`
 * is not enough. The page we are leaving keeps talking to
 * `/api/auth/session`, and NextAuth re-issues the session cookie on those
 * responses — one landing just after the clear puts the old session straight
 * back. `/auth/signin` then sees `status === 'authenticated'` and
 * `router.replace()`s to the *previous* user's dashboard while the test is
 * still typing into the form, so `page.click('button[type="submit"]')`
 * re-resolves against that dashboard. In the scheduled run it settled on the
 * mentee portal's disabled "Add goal" button and retried it until the action
 * timeout (meeting-requests, #965 follow-up).
 *
 * Two guards: going to `about:blank` first tears the old page (and its
 * requests) down *before* the session cookie is dropped, and the submit button
 * is looked up inside the sign-in form itself, so a stray redirect fails
 * loudly instead of clicking something unrelated on another page.
 *
 * Only the NextAuth session cookie is cleared — a blanket `clearCookies()`
 * would also drop the cookie-consent state seeded via `storageState`, bringing
 * the consent banner back over the form.
 */
export async function signInAsFreshUser(page: Page, email: string, password: string, landing: string) {
  await submitSignInForm(page, email, password);
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
}

/**
 * The guards of `signInAsFreshUser` without the landing wait, for accounts that
 * are *supposed* to stay on `/auth/signin` after submitting — a 2FA-enabled user
 * gets the authenticator field instead of a redirect.
 *
 * Everything in the doc comment above applies here; the landing wait is the only
 * difference. Rolling this by hand is what made two-factor.spec.ts flaky: with a
 * blanket `clearCookies()` and an unscoped `button[type="submit"]`, a submit
 * issued before `/auth/signin` had rendered resolved against the *previous*
 * page and sat on its disabled "Add note" button until the action timeout.
 */
export async function submitSignInForm(page: Page, email: string, password: string) {
  await page.goto('about:blank');
  await page.context().clearCookies({ name: /next-auth\.session-token/ });
  await page.goto('/auth/signin');
  const form = page.locator('form', { has: page.locator('input[type="password"]') });
  await form.locator('input[type="email"], input[name="email"]').fill(email);
  await form.locator('input[type="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
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
