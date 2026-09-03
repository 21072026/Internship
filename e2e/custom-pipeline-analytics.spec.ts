import { test, expect } from '@playwright/test';
import { prisma, seedCustomPipelineOrg, cleanupCustomPipelineOrg } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * A tenant that renamed its pipeline must still get a hiring funnel (#1886).
 *
 * Every other spec runs on the default stage catalogue, which is exactly why a
 * hardcoded `'HIRED_660'` has been reintroduced so often (#1880): the literal
 * type-checks, and on the default seed it is even correct. This spec is the
 * fixture that catches it — six stages keyed `STAGE_A`…`STAGE_F` and nothing
 * else, so any consumer reasoning about a default key reports zero here.
 *
 * The API assertion is the load-bearing one; the two testid assertions only
 * guard that the screen renders the resolved order rather than a default.
 * The headline conversion number on /admin/analytics is deliberately NOT
 * asserted: it still compares against 'HIRED_660'
 * (src/app/api/admin/analytics/route.ts) and #1882 owns that fix.
 */

const PASSWORD = 'CustomPipe123!';

let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  seeded = await seedCustomPipelineOrg('custom-pipe', PASSWORD);
});

test.afterAll(async () => {
  if (seeded) await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
  await prisma.$disconnect();
});

test('the hiring funnel reports on a tenant’s renamed pipeline', { tag: '@smoke' }, async ({ page }) => {
  await signInAndSettle(page, seeded.adminEmail, PASSWORD, '/admin');

  const res = await page.request.get('/api/admin/analytics/funnel');
  expect(res.ok()).toBeTruthy();
  const kpi = await res.json();
  // The order is the tenant's own stage set, in its own order — not the
  // canonical default catalogue.
  expect(kpi.order).toEqual(seeded.stageKeys);
  expect(kpi.journeys).toBeGreaterThan(0);
  // The seeded relation travelled STAGE_A → STAGE_F, so the last stage has an
  // entrant. A consumer that looked for a default key would report none.
  const last = (kpi.conversions as { key: string; entered: number }[]).find((c) => c.key === 'STAGE_F');
  expect(last?.entered).toBeGreaterThan(0);

  await gotoSettled(page, '/admin/analytics');
  await expect(page.getByTestId('funnel-kpi-card')).toBeVisible();
  await expect(page.getByTestId('conversion-STAGE_F')).toBeVisible();
  await expect(page.getByTestId('conversion-list')).not.toContainText('HIRED_660');
});
