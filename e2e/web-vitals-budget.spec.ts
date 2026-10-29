import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { seedMenteeWithRelation, cleanupMenteeWithRelation, type SeededRelation } from './helpers/db';
import { signInAsFreshUser, settleStreamedSuspense } from './helpers/auth';

// Front-end performance budget (#1593). k6 measures the server; this measures
// what a visitor's browser has to download and how the page settles, for the
// two screens that matter most on a phone: the landing page and the mentee
// portal. Budgets live in e2e/web-vitals-budget.json with the measured value
// they were set from — raise one only in the PR that knowingly pays for it.
//
// Three numbers per page:
//   jsKb — compressed JavaScript fetched by the first load. Deterministic for a
//          given build, so it is the budget that actually catches a regression
//          (a heavy library landing in a shared chunk).
//   cls  — Cumulative Layout Shift, also stable on a runner.
//   lcpMs — Largest Contentful Paint; runner-noisy, so its budget is a ceiling
//          for "something broke", not a tuning target.
//
// Only meaningful against a production build: `next dev` ships unminified
// bundles. It runs in CI (the gate serves `npm run start`) or with
// PERF_BUDGET=1; a local dev-server run skips it.

type Budget = { jsKb: number; cls: number; lcpMs: number; measured: { jsKb: number; cls: number; lcpMs: number } };
const budgets: Record<string, Budget> = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'web-vitals-budget.json'), 'utf8'),
).pages;

const enforce = !!process.env.CI || process.env.PERF_BUDGET === '1';

// Installed before any page script: buffered observers see entries from the
// very start of the navigation.
const OBSERVE = () => {
  const w = window as unknown as { __vitals: { lcp: number; cls: number } };
  w.__vitals = { lcp: 0, cls: 0 };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) w.__vitals.lcp = Math.max(w.__vitals.lcp, e.startTime);
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (!e.hadRecentInput) w.__vitals.cls += e.value;
    }
  }).observe({ type: 'layout-shift', buffered: true });
};

async function measure(page: Page) {
  // Let late chunks and shifts land before reading.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const w = window as unknown as { __vitals: { lcp: number; cls: number } };
    const js = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((r) => r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name))
      .reduce((sum, r) => sum + (r.encodedBodySize || r.transferSize || 0), 0);
    return { jsKb: Math.round(js / 1024), cls: Math.round(w.__vitals.cls * 1000) / 1000, lcpMs: Math.round(w.__vitals.lcp) };
  });
}

function check(route: string, got: { jsKb: number; cls: number; lcpMs: number }) {
  const b = budgets[route];
  test.info().annotations.push({ type: 'web-vitals', description: `${route} ${JSON.stringify(got)}` });
  expect.soft(got.jsKb, `${route}: JavaScript KB (budget ${b.jsKb})`).toBeLessThanOrEqual(b.jsKb);
  expect.soft(got.cls, `${route}: CLS (budget ${b.cls})`).toBeLessThanOrEqual(b.cls);
  expect.soft(got.lcpMs, `${route}: LCP ms (budget ${b.lcpMs})`).toBeLessThanOrEqual(b.lcpMs);
}

test.describe('web vitals budget', { tag: '@smoke' }, () => {
  test.skip(!enforce, 'needs a production build — set PERF_BUDGET=1 against `npm run start`');
  test.describe.configure({ mode: 'serial' });

  const PASSWORD = 'VitalsBudget123!';
  let related: SeededRelation;
  test.beforeAll(async () => {
    related = await seedMenteeWithRelation('Vitals', PASSWORD);
  });
  test.afterAll(async () => {
    if (related) await cleanupMenteeWithRelation(related);
  });

  test('landing page stays inside its budget', async ({ page }) => {
    await page.addInitScript(OBSERVE);
    await page.goto('/');
    check('/', await measure(page));
  });

  test('mentee portal stays inside its budget', async ({ page, baseURL }) => {
    await signInAsFreshUser(page, related.menteeEmail, PASSWORD, '/portal');
    // A fresh context, so the portal's first load is measured — not one warmed
    // by the sign-in page's chunks.
    const fresh = await page.context().browser()!.newContext({ baseURL, storageState: await page.context().storageState() });
    const p = await fresh.newPage();
    await p.addInitScript(OBSERVE);
    await p.goto('/portal');
    await settleStreamedSuspense(p);
    check('/portal', await measure(p));
    await fresh.close();
  });
});
