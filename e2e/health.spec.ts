import { test, expect } from '@playwright/test';

// The /api/health probe backs uptime monitoring and the nightly stress test.
// It must stay public, cheap, and side-effect free.
test('health endpoint reports ok without a DB check', { tag: '@smoke' }, async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(typeof body.version).toBe('string');
  expect(body.db).toBe('skipped');
  expect(typeof body.responseMs).toBe('number');
});

test('health endpoint verifies DB connectivity when asked', { tag: '@smoke' }, async ({ request }) => {
  const res = await request.get('/api/health?db=1');
  // 200 when the DB is reachable (CI/preview), 503 if it is degraded.
  expect([200, 503]).toContain(res.status());
  const body = await res.json();
  expect(['ok', 'error']).toContain(body.db);
});
