import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// WCAG 2.2.1 Timing Adjustable (#2864): five minutes before an idle session
// ends, an alert dialog says so and "Stay signed in" extends it. The browser
// clock is fast-forwarded to 11h56m after sign-in instead of waiting; the
// server clock is not, so the extension it returns is a real fresh 12 h.
test('session timeout: warned before the end, extended in one click', async ({ page }) => {
  test.slow();
  const email = uniqueEmail('session-timeout');
  const pw = 'SessionTimeout123';
  await seedUser(email, pw, 'MENTOR', 'Session Timeout');
  try {
    const realNow = Date.now();
    await page.clock.install({ time: realNow });
    await signInAndSettle(page, email, pw, '/mentor');

    const dialog = page.getByTestId('session-timeout-warning');
    await expect(dialog).toHaveCount(0);

    await page.clock.fastForward('11:56:00');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    await expect(dialog).toContainText('min');

    // Back to the real time before extending, so the new `expires` is 12 h
    // ahead of the page's clock again and the dialog has no reason to reopen.
    await page.clock.setSystemTime(Date.now());
    const extended = page.waitForRequest((r) => r.url().includes('/api/auth/session') && r.method() === 'POST');
    await page.getByTestId('session-timeout-stay').click();
    await extended;
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('You stay signed in for another 12 hours.')).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
