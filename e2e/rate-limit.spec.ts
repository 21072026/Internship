import { test, expect } from '@playwright/test';

// The forgot-password endpoint is limited to 5 requests / 15 min per IP.
//
// Both tests share one process-wide bucket keyed on the caller's IP, so they
// must stay in this file and in this order: the first exhausts the limit, the
// second checks that a spoofed header can't hand the caller a fresh one.
test('repeated forgot-password requests are rate limited (429)', async ({ request }) => {
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await request.post('/api/auth/forgot', {
      data: { email: `flood-${i}@example.com` },
    });
    statuses.push(res.status());
  }
  expect(statuses).toContain(200); // early requests pass
  expect(statuses).toContain(429); // later ones are throttled
});

/**
 * #858: `clientIp()` read the *leftmost* `X-Forwarded-For` entry — the part the
 * client writes. Rotating it per request bought a fresh bucket every time and
 * bypassed every IP-based limit in the app (measured: 12/12 spoofed requests
 * passed where the honest control got 7× 429).
 *
 * Playwright talks to Next directly, so `TRUSTED_PROXY_COUNT=0` is set for the
 * webServer (playwright.config.ts) and the header must be ignored outright.
 */
test('a rotating X-Forwarded-For does not buy a fresh rate-limit bucket', { tag: '@smoke' }, async ({ request }) => {
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    const res = await request.post('/api/auth/forgot', {
      data: { email: `spoof-${i}@example.com` },
      headers: { 'X-Forwarded-For': `9.9.9.${i}` },
    });
    statuses.push(res.status());
  }
  // 12 requests against a limit of 5 must hit the ceiling regardless of the
  // rotating header. Before the fix all 12 returned 200. (Run as part of the
  // full suite the bucket is already spent by the test above and every one of
  // them is a 429; run alone in the smoke subset the first few still pass.)
  expect(statuses).toContain(429);
});
