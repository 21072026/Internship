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
 * the scheduled full run.
 *
 * Used to wait for `networkidle` here, but the app never actually goes
 * network-idle on these pages: `TimezoneSync` fires a one-off
 * `POST /api/profile/timezone` on every authenticated mount, and the sidebar's
 * `<Link>`s prefetch every route in the nav. Under CI's single-core runner that
 * burst of concurrent requests can take a request past Playwright's 30s
 * `networkidle` budget even though the page itself has long finished rendering
 * (#1081) — `instant-meeting`, `pii-access-lifecycle`, `project-team-and-goals`
 * and `upcoming-meeting` all hung on exactly this. The account menu button is
 * in the shared shell on every authenticated role page, so waiting for it is a
 * deterministic "the landing page has actually mounted" signal that doesn't
 * depend on background requests ever going quiet.
 */
export async function signInAndSettle(page: Page, email: string, password: string, landing: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(landing), { timeout: 20_000 });
  await page.getByTestId('account-menu-button').waitFor({ state: 'visible', timeout: 20_000 });
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
 *
 * The session teardown is deliberately belt-and-braces. `/auth/signin` signs in
 * by polling `/api/auth/session` and then doing a full-page
 * `window.location.assign(roleHome)`, so `waitForURL()` returns while the old
 * page is still reading the session — and a read landing after `clearCookies()`
 * re-issues the cookie. `/auth/signin` then sees `authenticated` and
 * `router.replace()`s to the dashboard, leaving no form to fill: the failure is
 * a timeout on the password input, with no obvious culprit on screen. So: let
 * the outgoing page go quiet first, and if the form still isn't there, drop the
 * cookie again and reload once.
 */
export async function submitSignInForm(page: Page, email: string, password: string) {
  const form = page.locator('form', { has: page.locator('input[type="password"]') });

  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await dropSessionAndOpenSignIn(page);
  if (!(await form.isVisible().catch(() => false))) {
    await dropSessionAndOpenSignIn(page);
  }

  await form.locator('input[type="email"], input[name="email"]').fill(email);
  await form.locator('input[type="password"]').fill(password);
  await form.locator('button[type="submit"]').click();
}

async function dropSessionAndOpenSignIn(page: Page) {
  await page.goto('about:blank');
  await page.context().clearCookies({ name: /next-auth\.session-token/ });
  await page.goto('/auth/signin');
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
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
