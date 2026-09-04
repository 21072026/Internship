import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// AI endpoint rate limits (#2028):
// Rate limiting is keyed by authenticated user ID (and optionally org ID), so
// a user exhausting their limit receives a 429 while another user on the same
// network/IP remains unblocked.
test('AI endpoints isolate user limits without draining the org budget', { tag: '@smoke' }, async ({ page }) => {
  const menteeAEmail = uniqueEmail('airatelimit-a');
  const menteeBEmail = uniqueEmail('airatelimit-b');
  const pw = 'AiRateLimitPass123!';
  const org = await prisma.organization.create({
    data: { name: `AI Rate Limit Org ${Date.now()}`, slug: uniqueEmail('airatelimit-org').split('@')[0] },
  });
  const menteeA = await seedUser(menteeAEmail, pw, 'MENTEE', 'RateLimit Mentee A');
  const menteeB = await seedUser(menteeBEmail, pw, 'MENTEE', 'RateLimit Mentee B');
  await prisma.user.updateMany({
    where: { id: { in: [menteeA.id, menteeB.id] } },
    data: { orgId: org.id },
  });

  try {
    // 1. Sign in as User A
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeAEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Call /api/interview-prep up to the limit (6 calls / 10m).
    for (let i = 0; i < 6; i++) {
      const res = await page.request.post('/api/interview-prep', {
        data: { position: 'Backend Developer' },
      });
      // Initial 6 requests pass the rate limiter (and hit downstream logic, returning non-429).
      expect(res.status()).not.toBe(429);
    }

    // 7th request from User A must be throttled with 429.
    const throttledA = await page.request.post('/api/interview-prep', {
      data: { position: 'Backend Developer' },
    });
    expect(throttledA.status()).toBe(429);
    const jsonA = await throttledA.json();
    expect(jsonA.error).toBe('Too many requests. Please try again later.');
    expect(throttledA.headers()['retry-after']).toBeDefined();

    // A rejected user must not consume the shared 120-request org budget.
    // Drive User A to 120 total attempts; only their first six should reach the org limiter.
    const blockedA = await Promise.all(
      Array.from({ length: 113 }, () =>
        page.request.post('/api/interview-prep', {
          data: { position: 'Backend Developer' },
        })
      )
    );
    expect(blockedA.every((res) => res.status() === 429)).toBe(true);

    // 2. Sign in as User B in a second context (sharing the same network/IP).
    const ctxB = await page.context().browser()!.newContext();
    const pageB = await ctxB.newPage();
    try {
      await pageB.goto('/auth/signin');
      await pageB.fill('input[type="email"], input[name="email"]', menteeBEmail);
      await pageB.fill('input[type="password"]', pw);
      await pageB.click('button[type="submit"]');
      await pageB.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

      // User B must NOT be throttled even though User A is throttled on the same host/IP.
      const resB = await pageB.request.post('/api/interview-prep', {
        data: { position: 'Backend Developer' },
      });
      expect(resB.status()).not.toBe(429);
    } finally {
      await ctxB.close();
    }
  } finally {
    await cleanupByEmail(menteeAEmail);
    await cleanupByEmail(menteeBEmail);
    await prisma.organization.delete({ where: { id: org.id } });
  }
});
