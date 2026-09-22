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
 * The five reports that decide "was this person placed" are covered by
 * e2e/custom-pipeline-outcome-analytics.spec.ts (#1882) on the same fixture —
 * this spec stays about the funnel's stage ORDER, plus the headline conversion
 * tile (#2419): counted against the resolved finished stage and labelled from
 * it, so on this fixture it reads "Custom F rate" and never "Hired".
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

  // The headline conversion (#2419, the screen half of #1882). Its ratio is not
  // a number this fixture can predict — `conversionToHired` divides by every
  // relation the deployment can see, and tenant isolation is off outside the
  // `isolation` project — but the payload carries both sides of the division,
  // and this tenant's `finished` set is exactly ['STAGE_F'] (the last on-path
  // stage of the six seeded, none of them off-path). So the headline must be
  // the STAGE_F share of the same funnel map, whichever other rows the shared
  // database holds; the hardcoded `HIRED_660 + EMPLOYED_700` numerator this
  // tenant has no keys for cannot satisfy it.
  const ana = await (await page.request.get('/api/admin/analytics')).json();
  const funnel = ana.funnel as Record<string, number>;
  expect(funnel.STAGE_F ?? 0).toBeGreaterThanOrEqual(1);
  expect(ana.totalRelations).toBeGreaterThanOrEqual(funnel.STAGE_F);
  expect(ana.conversionToHired).toBe(Math.round((funnel.STAGE_F / ana.totalRelations) * 100));

  await gotoSettled(page, '/admin/analytics');
  await expect(page.getByTestId('funnel-kpi-card')).toBeVisible();
  await expect(page.getByTestId('conversion-STAGE_F')).toBeVisible();
  await expect(page.getByTestId('conversion-list')).not.toContainText('HIRED_660');

  // On screen: the tile carries that number, under a label built from the stage
  // it was counted against — so this tenant reads "Custom F rate" where the old
  // hardcoded key set made every screen say "Hired rate" about a stage the
  // tenant does not have. The tile renders its value first and its label
  // second, hence the anchored match.
  const headline = page.getByTestId('headline-conversion');
  await expect(headline).toContainText('Custom F rate');
  await expect(headline).toHaveText(new RegExp(`^${ana.conversionToHired}%`));
  await expect(headline).not.toContainText('Hired');
});
