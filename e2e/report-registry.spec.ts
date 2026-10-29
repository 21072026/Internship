import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Report registry (#1903): GET /api/admin/reports/[key]. The floor arithmetic
// is unit-tested (scripts/test/report-privacy-floor.test.mjs); this spec pins
// what only the real route can — the two entitlement gates, the 404s, and
// that a cohort under the floor never reaches the reader by name while the
// totals still add up.
//
// Its own organization, so toggling ADVANCED_ANALYTICS / REPORT_EXPORT here
// cannot race the analytics and export specs that share the default org.

const PW = 'Registry123!';

test.describe('report registry', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('rr-admin');
  const mentor = uniqueEmail('rr-mentor');
  const mentees = Array.from({ length: 9 }, (_, i) => uniqueEmail(`rr-mentee-${i}`));
  const bigName = `RR Big ${stamp}`;
  const smallNames = [`RR Small A ${stamp}`, `RR Small B ${stamp}`];
  let orgId = '';
  const cohortIds: string[] = [];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `RR Org ${stamp}`, slug: `rr-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `RR Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `RR Mentor ${stamp}`, orgId);
    const people = [];
    for (const [i, email] of mentees.entries()) people.push(await seedUser(email, 'x', 'MENTEE', `RR Mentee ${i} ${stamp}`, orgId));
    // 6 in the big cohort (over the floor of 5), 2 + 1 in the small ones.
    const sizes: [string, number][] = [[bigName, 6], [smallNames[0], 2], [smallNames[1], 1]];
    let next = 0;
    for (const [name, size] of sizes) {
      const cohort = await prisma.cohort.create({ data: { name, orgId } });
      cohortIds.push(cohort.id);
      for (let i = 0; i < size; i++) {
        await prisma.mentorshipRelation.create({
          data: { mentorId: m.id, menteeId: people[next++].id, orgId, cohortId: cohort.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
        });
      }
    }
  });

  test.afterAll(async () => {
    await prisma.orgEntitlement.deleteMany({ where: { orgId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.cohort.deleteMany({ where: { id: { in: cohortIds } } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('gates, 404s and the privacy floor', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    const get = (path: string) => page.request.get(`/api/admin/reports/${path}`);

    expect((await get('no-such-report')).status()).toBe(404);
    expect((await get('cohort-comparison?format=pdf')).status()).toBe(400);

    // Neither tier: even the JSON view is locked.
    const locked = await get('cohort-comparison');
    expect(locked.status()).toBe(403);
    expect(await locked.json()).toMatchObject({ code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' });

    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
    const res = await get('cohort-comparison');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const rows = body.rows as { cohort: string; total: number; conversion: number | null; avgDaysToOutcome: number | null }[];

    // The big cohort is shown as itself; the two small ones only as one bucket.
    expect(rows.find((r) => r.cohort === bigName)?.total).toBe(6);
    for (const name of smallNames) expect(rows.some((r) => r.cohort === name)).toBe(false);
    const bucket = rows.find((r) => r.cohort === '__suppressed__');
    expect(bucket).toMatchObject({ total: 3, conversion: null, avgDaysToOutcome: null });
    // Totals reconcile: 6 + 2 + 1 people, with or without the floor.
    expect(rows.reduce((n, r) => n + r.total, 0)).toBe(9);
    expect(body.privacyFloor).toMatchObject({ minCohort: 5, suppressedGroups: 2 });
    expect(body.privacyFloor.bucketLabel).toContain('5');

    // Every registered report loads for an INTERNSHIP org (it carries every
    // capability) and labels each of its columns.
    for (const key of ['pipeline-funnel', 'source-conversion', 'mentor-workload', 'placement-outcomes', 'weekly-report-compliance']) {
      const r = await get(key);
      expect(r.status(), key).toBe(200);
      const b = await r.json();
      expect(Array.isArray(b.rows), key).toBe(true);
      for (const c of b.columns as { key: string; label: string }[]) expect(c.label, `${key}.${c.key}`).not.toBe(c.key);
    }
    const workload = await (await get('mentor-workload')).json();
    expect(workload.rows).toContainEqual(expect.objectContaining({ mentor: `RR Mentor ${stamp}`, active: 9 }));

    // Viewing is not exporting: CSV and XLSX need REPORT_EXPORT on top.
    for (const format of ['csv', 'xlsx']) {
      const r = await get(`cohort-comparison?format=${format}`);
      expect(r.status()).toBe(403);
      expect(await r.json()).toMatchObject({ feature: 'REPORT_EXPORT' });
    }

    await setOrgFeature(orgId, 'REPORT_EXPORT', true);
    const csv = await get('cohort-comparison?format=csv');
    expect(csv.status()).toBe(200);
    expect(csv.headers()['content-type']).toContain('text/csv');
    const text = await csv.text();
    expect(text).toContain(bigName);
    expect(text).toContain(body.privacyFloor.bucketLabel);
    expect(text).toContain(body.privacyFloor.note);
    for (const name of smallNames) expect(text).not.toContain(name);

    const xlsx = await get('cohort-comparison?format=xlsx');
    expect(xlsx.status()).toBe(200);
    expect(xlsx.headers()['content-type']).toContain('spreadsheetml');
    // A real zip container, not an error page served with the right header.
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe('PK');

    // The analytics workbook's cohort sheet is the same report, so the same
    // floor (#1903 part 2) — the full report is exactly the file that leaves.
    const workbook = await (await page.request.get('/api/admin/export/analytics-full')).json();
    const cohortSheet = (workbook.sheets as { name: string; rows: (string | number)[][] }[]).find((s) => s.name === 'Cohorts')!;
    const cells = cohortSheet.rows.flat().map(String);
    expect(cells).toContain(bigName);
    expect(cells).toContain(body.privacyFloor.bucketLabel);
    expect(cells).toContain(body.privacyFloor.note);
    for (const name of smallNames) expect(cells).not.toContain(name);

    // …and the screen says so, next to the cards that still show every cohort.
    await page.goto('/admin/analytics');
    await expect(page.getByTestId('report-floor-footnote')).toContainText('5');
  });

  test('a mentor cannot read the registry', async ({ page }) => {
    await signInAndSettle(page, mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/reports/cohort-comparison')).status()).toBe(403);
  });
});
