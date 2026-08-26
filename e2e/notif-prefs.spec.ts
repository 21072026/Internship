import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a user can opt out of individual email categories', async ({ page }) => {
  const email = uniqueEmail('np-user');
  await seedUser(email, 'UserPass123', 'MENTEE', 'NP User');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'UserPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Opt out of message emails only.
    const put = await page.request.put('/api/profile', { data: { notificationPrefs: { messages: false, digest: true } } });
    expect(put.ok()).toBeTruthy();

    const me = await (await page.request.get('/api/profile')).json();
    expect(me.user.notificationPrefs.messages).toBe(false);
    expect(me.user.notificationPrefs.digest).toBe(true);
  } finally {
    await cleanupByEmail(email);
  }
});

// The email-delivery audit (#668) added the `mentorship` and `meetingReminders`
// opt-out categories. Verify they render in the account settings UI and that
// opting out through the UI persists across a reload.
test('the audit categories opt out through the account settings UI', async ({ page }) => {
  const email = uniqueEmail('np-cat');
  await seedUser(email, 'UserPass123', 'MENTEE', 'NP Cat');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'UserPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/account');

    const mentorship = page.locator('label', { hasText: 'Mentorship updates' }).getByRole('checkbox');
    const meetings = page.locator('label', { hasText: 'Meeting reminders' }).getByRole('checkbox');
    // Both audit categories are present and default to ON (opted in).
    await expect(mentorship).toBeVisible();
    await expect(meetings).toBeVisible();
    await expect(mentorship).toBeChecked();

    // Opt out of mentorship emails via the UI (auto-saves to /api/profile).
    await mentorship.uncheck();
    await expect
      .poll(async () => {
        const me = await (await page.request.get('/api/profile')).json();
        return me.user.notificationPrefs?.mentorship;
      })
      .toBe(false);

    // The opt-out survives a reload; unrelated categories stay opted in.
    await page.reload();
    await expect(page.locator('label', { hasText: 'Mentorship updates' }).getByRole('checkbox')).not.toBeChecked();
    await expect(page.locator('label', { hasText: 'Meeting reminders' }).getByRole('checkbox')).toBeChecked();
  } finally {
    await cleanupByEmail(email);
  }
});

// The per-group e-mail switches (#1290) live in the same card as the legacy
// in-app list above and write into the same notificationPrefs JSON column, under
// prefixed `email:<group>` keys. Two things have to hold, and only one of them
// is visible: the switch persists, and it does NOT take the legacy keys with it.
// /api/profile REPLACES that column rather than merging, so a UI that posted
// only its own keys would silently wipe every in-app opt-out the user had — a
// data-loss bug nobody would notice for months.
test('an e-mail group opts out through account settings without clobbering the legacy keys', async ({ page }) => {
  const email = uniqueEmail('np-group');
  const user = await seedUser(email, 'UserPass123', 'MENTEE', 'NP Group');

  try {
    // A pre-existing legacy opt-out, recorded the way the older UI records it.
    await prisma.user.update({
      where: { id: user.id },
      data: { notificationPrefs: { documents: false, messages: true } },
    });

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'UserPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/account');
    // Targeted by testid: the group names are full sentences of their own and a
    // `label`/`getByText` locator here would collide with the legacy list in the
    // same card (Playwright's hasText is a case-insensitive substring match).
    const digests = page.getByTestId('email-group-toggle-digests');
    await expect(digests).toBeVisible({ timeout: 15_000 });
    // ENABLED, not merely visible. The switch renders before GET /api/profile
    // answers, and until it does `notifPrefs` is still the empty placeholder —
    // so a click in that window used to PUT `{ 'email:digests': false }` over
    // the top of the whole blob and delete `documents`/`messages` outright. It
    // stays disabled until the stored preferences arrive; this is the assertion
    // that would catch that guard being removed, because `uncheck()` below
    // auto-waits for enabled and would otherwise hide the regression.
    await expect(digests).toBeEnabled({ timeout: 15_000 });
    // Nobody has touched it, so it reads as ON — silence is not consent to stop.
    await expect(digests).toBeChecked();

    // Sign-in and security mail has no switch at all, only an "always sent" row.
    await expect(page.getByTestId('email-group-toggle-account_security')).toHaveCount(0);
    await expect(page.getByTestId('email-group-essential-account_security')).toBeVisible();

    await digests.uncheck();
    await expect
      .poll(async () => {
        const me = await (await page.request.get('/api/profile')).json();
        return me.user.notificationPrefs?.['email:digests'];
      })
      .toBe(false);

    // The legacy keys survived the write, and the opt-out survives a reload.
    const me = await (await page.request.get('/api/profile')).json();
    expect(me.user.notificationPrefs.documents).toBe(false);
    expect(me.user.notificationPrefs.messages).toBe(true);

    await page.reload();
    await expect(page.getByTestId('email-group-toggle-digests')).not.toBeChecked();
    // The legacy `documents: false` resolves forward onto its group, so that
    // switch reads OFF even though no `email:` key was ever written for it.
    await expect(page.getByTestId('email-group-toggle-task_reminders')).not.toBeChecked();
  } finally {
    await cleanupByEmail(email);
  }
});
