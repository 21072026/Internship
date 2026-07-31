import { test, expect } from '@playwright/test';

// The endpoint that registers the scheduled jobs must never be startable by an
// anonymous request — the jobs send email to real people. CI sets no
// CRON_SECRET, so the expected answer there is 503 ("not configured"); where a
// secret IS set, a wrong or missing one must be 401. Both are "refused", and
// neither is 200 — that is the property under test.
test('POST /api/cron/start refuses an unauthenticated caller', { tag: '@smoke' }, async ({ request }) => {
  const cases: Record<string, string>[] = [{}, { 'x-cron-secret': 'wrong-secret' }];
  for (const headers of cases) {
    const res = await request.post('/api/cron/start', { headers });
    expect(res.status()).not.toBe(200);
    expect([401, 503]).toContain(res.status());
  }
});

// Same contract for the mail-bridge poller: it opens an outbound IMAP
// connection, so it must never run for an anonymous caller.
test('POST /api/inbound-email/poll refuses an unauthenticated caller', { tag: '@smoke' }, async ({ request }) => {
  const cases: Record<string, string>[] = [{}, { 'x-inbound-secret': 'wrong-secret' }];
  for (const headers of cases) {
    const res = await request.post('/api/inbound-email/poll', { headers });
    expect(res.status()).not.toBe(200);
    expect([401, 503]).toContain(res.status());
  }
});
