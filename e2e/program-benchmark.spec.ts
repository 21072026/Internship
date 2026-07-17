import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Premium Faz 2 (#542): cross-program benchmark is locked behind the
// premiumAnalytics setting; once enabled it returns ONLY anonymized aggregates
// (your metric + platform average + pool size) and never another program's
// identity or raw rows. Serial: toggles a global Setting, restored in finally.
test('program benchmark is gated and returns anonymized aggregates only', async ({ page }) => {
  const adminEmail = uniqueEmail('bench-admin');
  const pw = 'BenchPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Bench Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Locked by default.
    const locked = await page.request.get('/api/admin/analytics/benchmark');
    expect(locked.status()).toBe(403);

    // Enable premium tier.
    expect((await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } })).ok()).toBeTruthy();

    const res = await page.request.get('/api/admin/analytics/benchmark');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // Aggregate-only contract: platform block with a pool size + k-anonymity
    // floor; NO per-program list or identities anywhere in the payload.
    expect(body.platform).toBeTruthy();
    expect(typeof body.platform.poolSize).toBe('number');
    expect(body.platform.minRelations).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('orgId');
    expect(serialized).not.toContain('"name"');
    expect(Array.isArray(body.programs)).toBe(false);
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});

test('non-admin cannot read the benchmark', async ({ page }) => {
  const mentorEmail = uniqueEmail('bench-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Bench Mentor');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    expect((await page.request.get('/api/admin/analytics/benchmark')).status()).toBe(401);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
