import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail, prisma } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Google Calendar integration (#417, #709): the operator-level status endpoint,
// ADMIN-only. Since #709 the e2e run does set GOOGLE_* (pointed at a local
// stub), so this asserts the SHAPE and the access rule rather than a particular
// configured/enabled value — those depend on the deployment, not on the code.
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
    expect(typeof body.enabled).toBe('boolean');
    // A count, not an identity: how many people connected their own calendar.
    // Asserting a specific value here would only encode test-ordering.
    expect(typeof body.connections).toBe('number');
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
