import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// AI endpoint rate limits (#2028):
// An authenticated caller hitting an AI endpoint past its limit receives a 429
// with Retry-After header BEFORE any provider or DB read.
test('AI endpoints throttle requests past the limit with 429', async ({ page }) => {
  const menteeEmail = uniqueEmail('airatelimit-mentee');
  const pw = 'AiRateLimitPass123!';
  await seedUser(menteeEmail, pw, 'MENTEE', 'RateLimit Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Call /api/interview-prep up to the limit (6 calls / 10m).
    // The 7th call must return 429 Too Many Requests.
    for (let i = 0; i < 6; i++) {
      const res = await page.request.post('/api/interview-prep', {
        data: { position: 'Backend Developer' },
      });
      // Initial 6 requests pass the rate limiter (and hit downstream logic, returning non-429).
      expect(res.status()).not.toBe(429);
    }

    // 7th request must be throttled.
    const throttled = await page.request.post('/api/interview-prep', {
      data: { position: 'Backend Developer' },
    });
    expect(throttled.status()).toBe(429);
    const json = await throttled.json();
    expect(json.error).toBe('Too many requests. Please try again later.');
    expect(throttled.headers()['retry-after']).toBeDefined();
  } finally {
    await cleanupByEmail(menteeEmail);
  }
});
