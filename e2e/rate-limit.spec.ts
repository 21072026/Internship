import { test, expect } from '@playwright/test';
import { floodIp, freshIp } from './helpers/rateLimit';

// True when the suite talks to the app directly (its own webServer, or a dev
// server on this machine named by BASE_URL) rather than through a real proxy.
const noProxyInFront =
  !process.env.BASE_URL || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(process.env.BASE_URL);

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
// That includes the spoofing test below, and it does not weaken it: its claim is
// that the caller cannot buy a fresh bucket by rotating what THEY write, so it
// has to reach the ceiling on the one address it did not choose — the entry the
// proxy appends. The test plays that proxy, and pins that entry with `floodIp`.

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
 * The webServer runs at `TRUSTED_PROXY_COUNT=1` (playwright.config.ts) —
 * production's setting, so this is the attack exactly as it would arrive there
 * (#2470). Nothing sits in front of the e2e server, so each request carries what
 * a one-hop proxy would hand the app: the caller's rotating entry on the left,
 * the peer the proxy saw appended on the right. It used to run at `0` against a
 * single-entry header, a value production never uses.
 */
test('a rotating X-Forwarded-For does not buy a fresh rate-limit bucket', { tag: '@smoke' }, async ({ request }) => {
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) {
    const res = await request.post('/api/auth/forgot', {
      data: { email: `spoof-${i}@example.com` },
      headers: floodIp('forgot-password-spoof', `9.9.9.${i}`),
    });
    statuses.push(res.status());
  }
  // Limit 5: whatever the caller wrote, everything after the fifth request is
  // throttled. Before #858 all 12 returned 200. (A retry runs in a fresh worker,
  // whose `floodIp` may hand out a bucket the failed attempt already spent or
  // one it never touched; either way nothing after the fifth request passes, so
  // this assertion holds for both.)
  expect(statuses.slice(5)).toEqual(Array(7).fill(429));

  // Control: the key really is the appended entry. Another peer behind the same
  // proxy still gets through, so the 429s above are this caller's bucket — not
  // the endpoint failing, and not every caller sharing one counter, which is
  // what a webServer at TRUSTED_PROXY_COUNT=0 would do (and it would silently
  // void every floodIp/freshIp isolation in the suite with it).
  //
  // Only where nothing sits in front of the app. Against a deployed env a real
  // proxy appends the runner's own address to the right of every header these
  // helpers write, so the control lands in the bucket the flood just spent and
  // would read 429 for a reason that says nothing about the app.
  if (!noProxyInFront) {
    test.info().annotations.push({
      type: 'skipped-control',
      description: 'peer-isolation control needs the e2e helpers\' isolation, which a real proxy in front makes inert',
    });
    return;
  }
  const otherPeer = await request.post('/api/auth/forgot', {
    data: { email: 'spoof-control@example.com' },
    headers: freshIp('forgot-password-spoof-control'),
  });
  expect(otherPeer.status()).toBe(200);
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