import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail, prisma } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Google Calendar integration (#417): config-gated. With no GOOGLE_* env set
// (CI), status reports not-configured; the endpoint is ADMIN-only.
test('google calendar status is admin-only and reports config state', async ({ page }) => {
  const adminEmail = uniqueEmail('gcal-admin');
  await seedUser(adminEmail, 'GcalPass123', 'ADMIN', 'Gcal Admin');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'GcalPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.get('/api/admin/integrations/google/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.configured).toBe('boolean');
    expect(body.connected).toBe(false);
    // No secrets ever leak through the status endpoint.
    expect(JSON.stringify(body)).not.toContain('CLIENT_SECRET');
  } finally {
    await cleanupByEmail(adminEmail);
  }
});

test('non-admin cannot read google calendar status', async ({ page }) => {
  const menteeEmail = uniqueEmail('gcal-mentee');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Gcal Mentee');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });

    expect((await page.request.get('/api/admin/integrations/google/status')).status()).toBe(401);
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});
