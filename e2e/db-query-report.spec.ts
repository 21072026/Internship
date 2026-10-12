import { test, expect, type Page } from '@playwright/test';
import { cleanupByEmail, cleanupMenteeWithRelation, seedMenteeWithRelation, seedUser, uniqueEmail, type SeededRelation } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';

// The N+1 report (#1608) — REPORTING, not a gate.
//
// Opens the pages the admin audit flagged (#1436/#1437/#1438) and the inbox's
// known per-relation lookup, and records how many queries each one cost per
// Prisma model: the server render plus every API call the page makes before
// the network goes quiet. The numbers land in the test report (an attachment
// and an annotation per page); a model above REPORT_THRESHOLD is annotated as a
// suspected N+1. Nothing here fails on a count — a hard gate on day one would
// only be red on the offenders that already have their own fixes queued.
//
// Exact because Playwright runs one worker against one server (workers: 1), so
// nothing else is querying between the reset and the read. The tally exists
// only on the e2e server (DB_QUERY_TALLY=1 in playwright.config.ts); against a
// deployed BASE_URL the route is a 404 and the report skips itself.

const PW = 'DbReport123!';
const REPORT_THRESHOLD = 25;
const adminEmail = uniqueEmail('dbreport-admin');
let pair: SeededRelation;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await seedUser(adminEmail, PW, 'ADMIN', 'DB Report Admin');
  pair = await seedMenteeWithRelation('dbreport', PW);
});

test.afterAll(async () => {
  await cleanupByEmail(adminEmail);
  if (pair) await cleanupMenteeWithRelation(pair);
});

type Tally = { total: number; byModel: { model: string; count: number }[] };

async function measure(page: Page, admin: import('@playwright/test').APIRequestContext, path: string): Promise<Tally | null> {
  const reset = await admin.delete('/api/dev/db-tally');
  if (reset.status() === 404) return null;
  expect(reset.ok(), await reset.text()).toBe(true);
  await gotoSettled(page, path);
  await page.waitForLoadState('networkidle');
  const res = await admin.get('/api/dev/db-tally');
  expect(res.ok()).toBe(true);
  return (await res.json()) as Tally;
}

function report(path: string, tally: Tally) {
  const info = test.info();
  const suspects = tally.byModel.filter((r) => r.count > REPORT_THRESHOLD);
  const line = tally.byModel.map((r) => `${r.model}=${r.count}`).join(' ');
  info.annotations.push({ type: 'db-queries', description: `${path}: ${tally.total} queries — ${line}` });
  for (const s of suspects) {
    info.annotations.push({ type: 'suspected-n+1', description: `${path}: ${s.model} queried ${s.count}× (> ${REPORT_THRESHOLD})` });
  }
  console.log(`[db-query-report] ${path} total=${tally.total} ${line}`);
  return info.attach(`db-queries ${path}`, { body: JSON.stringify({ path, threshold: REPORT_THRESHOLD, ...tally }, null, 2), contentType: 'application/json' });
}

for (const target of [
  { path: '/messages', who: 'mentor' as const },
  { path: '/admin/board', who: 'admin' as const },
  { path: '/admin/candidates', who: 'admin' as const },
]) {
  test(`query report: ${target.path}`, async ({ page, playwright }, info) => {
    const admin = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
    try {
      expect((await signInViaApi(admin, adminEmail, PW)).ok).toBe(true);
      const email = target.who === 'admin' ? adminEmail : pair.mentorEmail;
      const landing = target.who === 'admin' ? '/admin' : '/mentor';
      await signInAsFreshUser(page, email, PW, landing);

      const tally = await measure(page, admin, target.path);
      test.skip(tally === null, 'query tally is off on this server (DB_QUERY_TALLY unset)');
      // The page did render through the database: a zero here means the tally
      // is not wired, which would make every report silently clean.
      expect(tally!.total).toBeGreaterThan(0);
      await report(target.path, tally!);
    } finally {
      await admin.dispose();
    }
  });
}
