import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// Slicing registry reports by an org-defined attribute (#1920, part 3):
// define → values → slice → suppression. 7 mentees in Engineering, 6 in Sales,
// 2 in Legal and 1 with no value: the groupBy variant shows Engineering and
// Sales and folds Legal + "no value" into ONE named below-threshold bucket, so
// the funnel's counts still add up to the unsliced total. A single small
// segment is answered as suppressed, never as an empty table. Four reports are
// sliced; a tenure slice comes from a start date; a deleted attribute degrades
// to the unsliced report. Own organization, so the gate it toggles races nobody.

const PW = 'Segments123!';
const DEPTS: [string, number][] = [['Engineering', 7], ['Sales', 6], ['Legal', 2], ['', 1]];

test.describe('report segments', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('seg-admin');
  const mentor = uniqueEmail('seg-mentor');
  const mentees: string[] = [];
  let orgId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `Seg Org ${stamp}`, slug: `seg-${stamp}` } })).id;
    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
    await setOrgFeature(orgId, 'REPORT_EXPORT', true);
    await seedUser(admin, PW, 'ADMIN', `Seg Admin ${stamp}`, orgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `Seg Mentor ${stamp}`, orgId);
    const dept = await prisma.orgAttribute.create({
      data: { orgId, key: 'department', labelEn: 'Department', labelTr: 'Bölüm', labelDe: 'Abteilung', type: 'SELECT', options: ['Engineering', 'Sales', 'Legal'] },
    });
    const start = await prisma.orgAttribute.create({ data: { orgId, key: 'start_date', labelEn: 'Start date', labelTr: '', labelDe: '', type: 'DATE' } });
    let i = 0;
    for (const [value, n] of DEPTS) {
      for (let k = 0; k < n; k++) {
        const email = uniqueEmail(`seg-mentee-${i++}`);
        mentees.push(email);
        const u = await seedUser(email, PW, 'MENTEE', `Seg Mentee ${i} ${stamp}`, orgId);
        await prisma.mentorshipRelation.create({ data: { orgId, mentorId: m.id, menteeId: u.id, pipelineStatus: 'APPLICATION_100' } });
        if (value) await prisma.userAttributeValue.create({ data: { orgId, userId: u.id, attributeId: dept.id, value } });
        // Everyone joined last month: one tenure segment of 16.
        await prisma.userAttributeValue.create({ data: { orgId, userId: u.id, attributeId: start.id, value: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10) } });
      }
    }
  });

  test.afterAll(async () => {
    await prisma.orgAttribute.deleteMany({ where: { orgId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.orgEntitlement.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  const get = async (page: Page, path: string) => {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(200);
    return res.json();
  };
  const funnelTotal = (rows: { count: number }[]) => rows.reduce((n, r) => n + r.count, 0);

  test('slice → suppress → reconcile, across four reports, in the API and on screen', async ({ page }) => {
    test.setTimeout(180_000);
    await signInAndSettle(page, admin, PW, '/admin');

    const plain = await get(page, '/api/admin/reports/pipeline-funnel');
    expect(funnelTotal(plain.rows)).toBe(16);

    // groupBy: two segments plus the bucket; Legal and "no value" never appear alone.
    const grouped = await get(page, '/api/admin/reports/pipeline-funnel?segmentBy=department');
    expect(grouped.columns[0]).toMatchObject({ key: 'segment', label: 'Department' });
    const segments = [...new Set(grouped.rows.map((r: { segment: string }) => r.segment))];
    expect(segments).toEqual(['Engineering', 'Sales', expect.stringContaining('Below reporting threshold')]);
    expect(segments).not.toContain('Legal');
    expect(grouped.segment).toMatchObject({ by: 'department', value: null, suppressedSegments: 2 });
    expect(grouped.privacyFloor.minCohort).toBe(5);
    // The totals reconcile: every person is in exactly one segment.
    expect(funnelTotal(grouped.rows)).toBe(16);
    const bySegment = (name: string) => funnelTotal(grouped.rows.filter((r: { segment: string }) => r.segment === name));
    expect(bySegment('Engineering')).toBe(7);
    expect(bySegment('Sales')).toBe(6);

    // Filter mode: a large segment alone; a small one is suppressed, explicitly.
    const eng = await get(page, '/api/admin/reports/pipeline-funnel?segmentBy=department&segment=Engineering');
    expect(funnelTotal(eng.rows)).toBe(7);
    const legal = await get(page, '/api/admin/reports/pipeline-funnel?segmentBy=department&segment=Legal');
    expect(legal.rows).toEqual([]);
    expect(legal.segment).toMatchObject({ suppressed: true });
    expect(legal.segment.note).toContain('fewer than 5');

    // Four more registry reports take the same slice.
    for (const key of ['pipeline-summary', 'cohort-comparison', 'source-conversion', 'mentor-workload']) {
      const r = await get(page, `/api/admin/reports/${key}?segmentBy=department`);
      expect(r.segment, key).toMatchObject({ by: 'department' });
      expect(r.columns[0].key, key).toBe('segment');
    }
    const summary = await get(page, '/api/admin/reports/pipeline-summary?segmentBy=department&segment=Sales');
    expect(summary.rows[0].value).toBe(6);

    // Tenure is derived from the start date, never stored.
    const tenure = await get(page, '/api/admin/reports/pipeline-funnel?segmentBy=start_date');
    expect([...new Set(tenure.rows.map((r: { segment: string }) => r.segment))]).toEqual(['Under 1 year']);
    expect(await prisma.userAttributeValue.count({ where: { orgId, value: { contains: 'year' } } })).toBe(0);

    // The export carries the segment column and the floor's note.
    const csv = await page.request.get('/api/admin/reports/pipeline-funnel?segmentBy=department&format=csv');
    expect(csv.status()).toBe(200);
    const text = await csv.text();
    expect(text).toContain('"Department"');
    expect(text).toContain('Below reporting threshold');

    // On screen.
    await gotoSettled(page, '/admin/reports');
    await page.getByTestId('segment-by-picker').selectOption('department');
    await expect(page.getByTestId('report-table')).toContainText('Engineering');
    await expect(page.getByTestId('report-table')).toContainText('Below reporting threshold');
    await expect(page.getByTestId('report-table')).not.toContainText('Legal');
    await page.getByTestId('segment-picker').selectOption('Legal');
    await expect(page.getByTestId('report-segment-suppressed')).toBeVisible();

    // A subscription can store the slice; deleting the attribute degrades it.
    const sub = await page.request.post('/api/admin/report-subscriptions', {
      data: { reportKey: 'pipeline-funnel', cadence: 'WEEKLY', dayOfWeek: 1, hour: 6, locale: 'en', format: 'EMAIL_SUMMARY', recipientEmail: `seg-dean-${stamp}@example.com`, segmentBy: 'department' },
    });
    expect(sub.status()).toBe(201);
    expect((await sub.json()).subscription.params).toEqual({ segmentBy: 'department' });
    expect(
      (await page.request.post('/api/admin/report-subscriptions', {
        data: { reportKey: 'pipeline-funnel', cadence: 'WEEKLY', dayOfWeek: 1, hour: 6, locale: 'en', format: 'EMAIL_SUMMARY', recipientEmail: `seg-x-${stamp}@example.com`, segmentBy: 'nope' },
      })).status()
    ).toBe(400);
    await prisma.orgAttribute.deleteMany({ where: { orgId, key: 'department' } });
    const degraded = await get(page, '/api/admin/reports/pipeline-funnel?segmentBy=department');
    expect(degraded.segment).toBeNull();
    expect(degraded.segmentIgnored).toMatchObject({ code: 'unknown_attribute' });
    expect(funnelTotal(degraded.rows)).toBe(16);
    await prisma.reportSubscription.deleteMany({ where: { orgId } });
  });
});
