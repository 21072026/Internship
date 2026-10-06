import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';

// /admin/analytics/roi (#1895). Its own org, so every number below is the
// arithmetic of the rows seeded here:
//   costs        — STAFF €10,000 + PLATFORM €2,000 overlapping the window; a
//                  line from two years ago that must NOT count.
//   placements   — A: a ledger row worth €20,000 inside the window;
//                  B: reached HIRED inside the window, no ledger row → valued
//                     from the assumptions (€9,000 fee + 2 × €4,500 = €18,000);
//                  C: first reached HIRED two years ago, touched again this
//                     month → not a new hire.
//   → cost 12,000 · value 38,000 · net 26,000 · ROI 217% · €6,000 per placement.

const PW = 'AdminRoi123!';
const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

test.describe('programme ROI', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('roi-admin');
  const lockedAdmin = uniqueEmail('roi-locked-admin');
  const mentor = uniqueEmail('roi-mentor');
  const mentees = ['a', 'b', 'c'].map((k) => uniqueEmail(`roi-mentee-${k}`));
  let orgId = '';
  let lockedOrgId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `ROI Org ${stamp}`, slug: `roi-${stamp}` } })).id;
    lockedOrgId = (await prisma.organization.create({ data: { name: `ROI Locked ${stamp}`, slug: `roi-locked-${stamp}` } })).id;
    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
    await seedUser(admin, PW, 'ADMIN', `ROI Admin ${stamp}`, orgId);
    await seedUser(lockedAdmin, PW, 'ADMIN', `ROI Locked Admin ${stamp}`, lockedOrgId);
    const m = await seedUser(mentor, PW, 'MENTOR', `ROI Mentor ${stamp}`, orgId);
    const [a, b, c] = await Promise.all(mentees.map((e, i) => seedUser(e, PW, 'MENTEE', `ROI Mentee ${i} ${stamp}`, orgId)));

    const now = Date.now();
    await prisma.programCost.createMany({
      data: [
        { orgId, category: 'STAFF', label: 'Coordinator', amountMinor: 1_000_000, currency: 'EUR', periodStart: new Date(now - 60 * DAY), periodEnd: new Date(now - 30 * DAY) },
        { orgId, category: 'PLATFORM', label: 'Licence', amountMinor: 200_000, currency: 'EUR', periodStart: new Date(now - 90 * DAY), periodEnd: new Date(now + 30 * DAY) },
        { orgId, category: 'EVENT', label: 'Old kick-off', amountMinor: 500_000, currency: 'EUR', periodStart: new Date(now - 800 * DAY), periodEnd: new Date(now - 790 * DAY) },
      ],
    });
    const rel = (menteeId: string) =>
      prisma.mentorshipRelation.create({ data: { orgId, mentorId: m.id, menteeId, pipelineStatus: 'HIRED_660', status: 'COMPLETED', completedAt: new Date() } });
    const [ra, rb, rc] = [await rel(a.id), await rel(b.id), await rel(c.id)];
    await prisma.placement.create({ data: { orgId, relationId: ra.id, menteeId: a.id, placedAt: new Date(now - 10 * DAY), valueMinor: 2_000_000, valueCurrency: 'EUR', valueSource: 'MANUAL' } });
    await prisma.statusChange.createMany({
      data: [
        { relationId: ra.id, fromStatus: 'INTERNSHIP_COMPLETED_490', toStatus: 'HIRED_660', createdAt: new Date(now - 10 * DAY) },
        { relationId: rb.id, fromStatus: 'INTERNSHIP_COMPLETED_490', toStatus: 'HIRED_660', createdAt: new Date(now - 20 * DAY) },
        { relationId: rc.id, fromStatus: 'INTERNSHIP_COMPLETED_490', toStatus: 'HIRED_660', createdAt: new Date(now - 700 * DAY) },
        { relationId: rc.id, fromStatus: 'JOB_SEEKING_500', toStatus: 'HIRED_660', createdAt: new Date(now - 5 * DAY) },
      ],
    });
  });

  test.afterAll(async () => {
    await prisma.programCost.deleteMany({ where: { orgId } });
    await prisma.placement.deleteMany({ where: { orgId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, lockedAdmin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: [orgId, lockedOrgId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, lockedOrgId] } } });
    await prisma.$disconnect();
  });

  test('the number, every step, and assumptions that recalculate it', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');

    const api = await (await page.request.get('/api/admin/analytics/roi')).json();
    expect(api.result).toMatchObject({
      ok: true,
      currency: 'EUR',
      totalCostMinor: 1_200_000,
      placementCount: 2,
      valuedPlacements: 1,
      assumedPlacements: 1,
      recordedValueMinor: 2_000_000,
      assumedValueMinor: 1_800_000,
      netMinor: 2_600_000,
      costPerPlacementMinor: 600_000,
      roiPercent: 217,
    });
    expect(api.placementSources).toEqual({ ledger: 1, stage: 1 });
    expect(api.costsByCategory.map((g: { category: string }) => g.category)).toEqual(['STAFF', 'PLATFORM']);

    await page.goto('/admin/analytics/roi');
    await expect(page.getByTestId('roi-percent')).toHaveText('217%');
    await expect(page.getByTestId('roi-placements')).toHaveText('2');
    for (const key of ['programCost', 'totalCost', 'placements', 'recordedValue', 'assumedValue', 'realisedValue', 'costPerPlacement', 'net', 'roiPercent']) {
      await expect(page.getByTestId(`roi-step-${key}`)).toBeVisible();
    }
    await expect(page.getByTestId('roi-step-assumedValue')).toContainText('1 x 1800000 = 1800000');
    await expect(page.getByTestId('roi-estimate-warning')).toBeVisible();
    await expect(page.getByTestId('roi-placements-note')).toContainText('1');

    // An assumption is query state: no recruiter fee avoided → €9,000 per
    // assumed placement → value 29,000, net 17,000, ROI 142%.
    await page.getByTestId('roi-assumption-recruiterFeeAvoidedPerPlacementMinor').fill('0');
    await expect(page.getByTestId('roi-percent')).toHaveText('142%');
    await page.getByTestId('roi-reset').click();
    await expect(page.getByTestId('roi-percent')).toHaveText('217%');

    // A window before any of it: nothing spent, nothing placed.
    const old = await (await page.request.get(`/api/admin/analytics/roi?from=${iso(new Date(Date.now() - 400 * DAY))}&to=${iso(new Date(Date.now() - 300 * DAY))}`)).json();
    expect(old.result).toMatchObject({ ok: true, totalCostMinor: 0, placementCount: 0, roiPercent: null });
  });

  // A sponsor prints it into a renewal deck: one A4 sheet in every language,
  // German being the longest. page.pdf() renders with the print stylesheet.
  test('prints to one A4 page in EN, TR and DE', async ({ page, browserName, baseURL }) => {
    test.skip(browserName !== 'chromium', 'page.pdf() is Chromium-only');
    await signInAndSettle(page, admin, PW, '/admin');
    for (const locale of ['en', 'tr', 'de']) {
      await page.context().addCookies([{ name: 'locale', value: locale, url: baseURL! }]);
      await page.goto('/admin/analytics/roi');
      await expect(page.getByTestId('roi-percent')).toHaveText('217%');
      await expect(page.getByTestId('roi-assumptions')).toBeVisible();
      const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
      const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
      expect(pages, `${locale} prints on ${pages} page(s)`).toBe(1);
    }
  });

  test('locked without ADVANCED_ANALYTICS, and ADMIN-only — at the API, not just the button', async ({ page }) => {
    await signInAndSettle(page, lockedAdmin, PW, '/admin');
    const res = await page.request.get('/api/admin/analytics/roi');
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'feature_locked', feature: 'ADVANCED_ANALYTICS' });
    await page.goto('/admin/analytics/roi');
    await expect(page.getByTestId('roi-locked')).toBeVisible();

    await signInAsFreshUser(page, mentor, PW, '/mentor');
    expect((await page.request.get('/api/admin/analytics/roi')).status()).toBe(403);
  });
});
