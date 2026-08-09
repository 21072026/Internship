import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1196: outbound mail splits into two channels by category so the scheduled
// digests/reminders cannot eat a relay's daily allowance (Brevo free is 300/day
// across everything). This asserts the wiring, not a particular deployment's
// env: the split has to be visible to the admin and the bulk category list has
// to contain the jobs that actually generate the volume.
test('admin email panel exposes both outbound channels and the bulk category list', async ({ page }) => {
  const adminEmail = uniqueEmail('chan-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Channel Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.get('/api/admin/email-test');
    expect(res.ok()).toBeTruthy();
    const info = await res.json();

    // Both channels are reported, so the panel can show the split.
    expect(info.bulkSmtp).toBeTruthy();
    expect(typeof info.bulkSmtp.configured).toBe('boolean');
    expect(info.channels).toBeTruthy();

    // The high-volume scheduled jobs must be on the bulk list — these are the
    // ones that would otherwise exhaust the relay quota.
    for (const category of ['unread-digest', 'activity-digest', 'meeting-reminder', 'announcement']) {
      expect(info.channels.bulkCategories).toContain(category);
    }
    // Mail a person is waiting on must never be classed as bulk.
    for (const category of ['verification', 'invitation', 'password-reset', 'message']) {
      expect(info.channels.bulkCategories).not.toContain(category);
    }

    // The quota view answers "how close are we to the daily cap, and what is
    // spending it?" without shell access.
    const log = await page.request.get('/api/admin/email-log?limit=5');
    expect(log.ok()).toBeTruthy();
    const logBody = await log.json();
    expect(logBody.last24h).toMatchObject({
      primary: expect.any(Number),
      bulk: expect.any(Number),
    });
    expect(Array.isArray(logBody.byCategory)).toBe(true);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
