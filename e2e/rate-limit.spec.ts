import { test, expect } from '@playwright/test';
import { floodIp } from './helpers/rateLimit';

// EVERY FLOOD IN THIS FILE SPENDS ITS OWN SYNTHETIC IP (#2159).
//
// `enforceRateLimit` keys on `bucket:ip` and the counter store is per PROCESS,
// so a test that deliberately exhausts a bucket used to exhaust it for every
// later spec hitting the same endpoint — for the rest of the shard, since the
// window is 15 minutes. The support flood below was failing
// `support-attachments.spec.ts` and `support-chat.spec.ts` with 429 on every
// scheduled run. `floodIp()` gives each flood here an address of its own; the
// reasoning, and the matching `freshIp()` the other specs use, is in
// e2e/helpers/rateLimit.ts.
//
// Isolation must NOT be applied to the spoofing test below: its whole point is
// that the caller cannot buy a fresh bucket, so it has to reach the ceiling on
// one address it did not choose.

// The forgot-password endpoint is limited to 5 requests / 15 min per IP.
//
// These two tests no longer share a bucket, and the spoofing test below is
// stronger for it: it used to lean on this one having already spent the shared
// counter, and now it has to reach the ceiling on its own 12 requests — which
// is the actual claim, that a rotating header buys nothing.
test('repeated forgot-password requests are rate limited (429)', async ({ request }) => {
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) {
    const res = await request.post('/api/auth/forgot', {
      data: { email: `flood-${i}@example.com` },
      headers: floodIp('forgot-password'),
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
test('support submissions are rate limited and return Retry-After', async ({ request }) => {
  const statuses: number[] = [];
  let retryAfter: string | undefined;

  for (let i = 0; i < 6; i++) {
    const response = await request.post('/api/support', {
      data: { body: 'rate-limit test' },
      headers: floodIp('support'),
    });
    statuses.push(response.status());

    if (response.status() === 429) {
      retryAfter = response.headers()['retry-after'];
    }
  }

  expect(statuses).toContain(429);
  expect(retryAfter).toBeTruthy();
});