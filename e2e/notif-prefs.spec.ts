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
