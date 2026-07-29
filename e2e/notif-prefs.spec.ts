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
