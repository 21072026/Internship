import { test, expect } from '@playwright/test';
import { E2E_HEALTH_TOKEN } from '../playwright.config';

// The /api/health probe backs uptime monitoring and the nightly stress test.
// It must stay public, cheap, and side-effect free.
//
// What it may *say* to an anonymous caller is narrower since #897: version and
// git sha told an attacker which CVEs apply to this deployment. Those fields
// are gated on HEALTH_TOKEN, which the local webServer sets (playwright.config).
// Against a deployed BASE_URL the token is whatever that env uses, so the
// gated-shape assertions only run locally.
const local = !process.env.BASE_URL;

test('health endpoint reports ok without a DB check', { tag: '@smoke' }, async ({ request }) => {
  const res = await request.get('/api/health', {
    headers: local ? { 'X-Health-Token': E2E_HEALTH_TOKEN } : {},
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
  expect(typeof body.version).toBe('string');
  expect(body.db).toBe('skipped');
  expect(typeof body.responseMs).toBe('number');
});

test('health endpoint verifies DB connectivity when asked', { tag: '@smoke' }, async ({ request }) => {
  const res = await request.get('/api/health?db=1', {
    headers: local ? { 'X-Health-Token': E2E_HEALTH_TOKEN } : {},
  });
  // 200 when the DB is reachable (CI/preview), 503 if it is degraded.
  expect([200, 503]).toContain(res.status());
  const body = await res.json();
  expect(['ok', 'error']).toContain(body.db);
});

// #1701: two replicas serve every environment behind one proxy, so "which
// process answered, and which one is running the scheduler?" has to be
// answerable from outside the box. The identity rides the existing detail gate;
// the lease rows cost a query, so they are opt-in and need the same proof of
// identity as the queue counters.
test('the detail view names the replica, and ?leases=1 reports the lease holders', async ({ request }) => {
  test.skip(!local, 'needs the local HEALTH_TOKEN and this environment’s own DB');

  const res = await request.get('/api/health?leases=1', {
    headers: { 'X-Health-Token': E2E_HEALTH_TOKEN },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(typeof body.replica).toBe('string');
  expect(body.replica.length).toBeGreaterThan(0);
  // An array — empty here, because a single-container test environment has
  // never had a reason to take a lease. The shape is what matters: the field is
  // read from the JobLease rows, so an empty array means "nobody holds
  // anything", not "the query failed" (which would be null).
  expect(Array.isArray(body.leases)).toBe(true);
  for (const lease of body.leases) {
    expect(typeof lease.holder).toBe('string');
    expect(typeof lease.mine).toBe('boolean');
  }

  // Without the token the lease rows are not released at all — no fail-open
  // path, same rule as the queue counters.
  const anon = await request.get('/api/health?leases=1');
  expect((await anon.json()).leases).toBeUndefined();
});

test('an anonymous caller sees liveness only, not the version or sha', { tag: '@smoke' }, async ({ request }) => {
  test.skip(!local, 'the deployed env may not have HEALTH_TOKEN configured');
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  const body = await res.json();
  // Still everything an uptime monitor acts on…
  expect(body.status).toBe('ok');
  // …and nothing that answers "which CVEs apply here?".
  expect(body.version).toBeUndefined();
  expect(body.sha).toBeUndefined();
  expect(body.uptimeMs).toBeUndefined();

  // A wrong token is no better than none.
  const wrong = await request.get('/api/health', { headers: { 'X-Health-Token': 'not-the-token' } });
  expect((await wrong.json()).version).toBeUndefined();
});
