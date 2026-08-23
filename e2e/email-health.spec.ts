import { test, expect } from '@playwright/test';
import { E2E_HEALTH_TOKEN } from '../playwright.config';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// E-mail delivery failure visibility (#1190): health is DERIVED from the
// EmailLog ledger (#1194) — last success, failures since, attempts in 24h —
// and surfaced on /api/admin/email-health, the /api/health detail view and an
// hourly check that writes an `email.health_alert` ActivityLog row when the
// channel looks dead. Recipient addresses must never leak into any of it.
const local = !process.env.BASE_URL;

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('derived email health: counters, PII scrubbing, health endpoints, stale alert', async ({ page, request }) => {
  test.skip(!local, 'seeds EmailLog rows directly — local DB only');

  const adminEmail = uniqueEmail('emailhealth-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'EmailHealth Admin');

  // The channel's story: one success 7h ago, then three failures — the last
  // one echoing the recipient's address, as SMTP rejections do.
  const failTo = uniqueEmail('emailhealth-victim');
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
  const seeded: string[] = [];
  const mkLog = async (status: 'SENT' | 'FAILED', createdAt: Date, error?: string) => {
    const row = await prisma.emailLog.create({
      data: { to: failTo, subject: 'e2e email health probe', category: 'e2e-health', status, error: error ?? null, createdAt },
    });
    seeded.push(row.id);
  };
  await mkLog('SENT', sevenHoursAgo);
  await mkLog('FAILED', new Date(Date.now() - 3 * 60 * 1000), 'Connection refused');
  await mkLog('FAILED', new Date(Date.now() - 2 * 60 * 1000), 'Connection refused');
  await mkLog('FAILED', new Date(Date.now() - 1 * 60 * 1000), `550 Recipient ${failTo} rejected`);

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // 1) Admin endpoint: counters derived from the ledger, error scrubbed.
    // Other specs run in parallel and also write EmailLog rows, so the
    // assertions are lower bounds, not exact equality.
    const adminRes = await page.request.get('/api/admin/email-health');
    expect(adminRes.status()).toBe(200);
    const adminHealth = (await adminRes.json()).email;
    expect(adminHealth.failuresSinceOk).toBeGreaterThanOrEqual(3);
    expect(adminHealth.attempts24h).toBeGreaterThanOrEqual(3);
    expect(adminHealth.lastErrorAt).not.toBeNull();
    // The recipient's address never leaves the server — scrubbed at read time.
    expect(adminHealth.lastError).toContain('<redacted>');
    expect(JSON.stringify(adminHealth)).not.toContain('@e2e.local');

    // 2) /api/health detail view carries the same block (token-gated).
    const healthRes = await page.request.get('/api/health', {
      headers: { 'X-Health-Token': E2E_HEALTH_TOKEN },
    });
    expect(healthRes.status()).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.email).toBeTruthy();
    expect(healthBody.email.failuresSinceOk).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(healthBody.email)).not.toContain('@e2e.local');

    // …and an anonymous caller still sees liveness only, no delivery detail.
    // The `request` fixture carries no browser cookies — page.request would
    // ride the admin session, which legitimately sees the detail view.
    const anonRes = await request.get('/api/health');
    expect((await anonRes.json()).email).toBeUndefined();

    // 3) The hourly check, run on demand: with the last success 7h old and
    // failures since, the channel is stale → a durable ActivityLog alert.
    const cronRes = await page.request.get('/api/cron?job=email-health');
    expect(cronRes.ok()).toBeTruthy();
    const cronHealth = (await cronRes.json()).email;
    const wasStale =
      (!cronHealth.lastOkAt || Date.parse(cronHealth.lastOkAt) < Date.now() - 6 * 60 * 60 * 1000) &&
      cronHealth.attempts24h > 0 &&
      cronHealth.failuresSinceOk > 0;
    if (wasStale) {
      // Not cleaned up on purpose: the alert is in-memory-deduped for 6h, so a
      // rerun against a long-lived dev server must still find the earlier row.
      const alerts = await prisma.activityLog.count({ where: { action: 'email.health_alert' } });
      expect(alerts).toBeGreaterThanOrEqual(1);
    }
    // A parallel spec can insert a fresh SENT row and un-stale the ledger
    // (email-hardening does); then the alert legitimately does not fire and
    // only the derived numbers above are asserted.

    // 4) The admin settings page shows the derived line.
    await page.goto('/admin/settings');
    await expect(page.getByTestId('email-delivery-health')).toBeVisible();
  } finally {
    await prisma.emailLog.deleteMany({ where: { id: { in: seeded } } });
    await cleanupByEmail(adminEmail);
  }
});
