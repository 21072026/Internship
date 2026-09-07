import { test, expect } from '@playwright/test';
import { prisma } from '../helpers/db';
import { seedTwoTenants, signInAsTenantActor, type TwoTenants } from '../helpers/tenants';

/**
 * The gate spec for the `isolation` Playwright project (#1566).
 *
 * Everything else in e2e/isolation/ is worthless if the server behind
 * `baseURL` did not actually come up with `MT_ENFORCE_ISOLATION=true` — a
 * cross-tenant assertion against an unenforced server passes for the wrong
 * reason as often as not. So this file proves the flag first, and it proves it
 * the only way a test can: by observing behaviour that exists ONLY when the
 * flag is on.
 *
 * `GET /api/companies` is that behaviour. The handler runs
 * `prisma.company.findMany()` with no `where` at all, inside
 * `withTenantScope(session, …)`. `Company` is registered in `TENANT_MODELS`, so:
 *
 *   flag ON   the middleware injects the caller's orgId → tenant A's admin sees
 *             tenant A's company and not tenant B's;
 *   flag OFF  the middleware early-returns → the same call lists every company
 *             in the database, tenant B's included.
 *
 * That makes the assertion below a live check of the server's env, not a
 * restatement of it. Run the same file under the default project and it fails,
 * which is exactly why `playwright.config.ts` keeps e2e/isolation/** out of it.
 */

let tenants: TwoTenants;

test.beforeAll(async () => {
  tenants = await seedTwoTenants();
});

test.afterAll(async () => {
  await tenants?.cleanup();
  await prisma.$disconnect();
});

test('the app under test answers at all', async ({ request }) => {
  // A liveness probe, so a server that failed to boot fails here with a clear
  // message instead of inside a sign-in timeout further down.
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
});

test('the server enforces tenant isolation (MT_ENFORCE_ISOLATION is on)', async ({ page }) => {
  await signInAsTenantActor(page, tenants.orgA.admin);

  // page.request shares the browser context's cookies, so this is the signed-in
  // admin's own call — the same one the companies screen makes.
  const res = await page.request.get('/api/companies');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { companies: Array<{ id: string; name: string }> };
  const ids = body.companies.map((c) => c.id);

  expect(ids).toContain(tenants.orgA.company.id);
  expect(
    ids,
    'tenant B’s company is visible to tenant A — either MT_ENFORCE_ISOLATION is not set on ' +
      'this server, or Company fell out of TENANT_MODELS in src/lib/orgContext.ts'
  ).not.toContain(tenants.orgB.company.id);
});

test('enforcement holds in both directions', async ({ page }) => {
  // The mirror image of the test above. A filter that is accidentally pinned to
  // one tenant — the first one seeded, the caller's own row, a stale closure —
  // passes one direction and fails the other; asking both is what makes the
  // pass mean "scoped by the caller's org".
  await signInAsTenantActor(page, tenants.orgB.admin);

  const res = await page.request.get('/api/companies');
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { companies: Array<{ id: string }> };
  const ids = body.companies.map((c) => c.id);

  expect(ids).toContain(tenants.orgB.company.id);
  expect(ids).not.toContain(tenants.orgA.company.id);
});
