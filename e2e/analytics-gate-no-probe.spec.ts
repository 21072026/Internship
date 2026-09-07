import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1442: the analytics screen used to learn whether the premium tier was on by
// CALLING the gated endpoints and reading the 403 back. An unentitled admin
// therefore paid four failed requests and four red console lines on every open
// of /admin/analytics (two more on /admin/analytics/report) — a designed state
// that read as a broken one, and noise that trains everyone to ignore the
// console.
//
// This spec pins the network sequence rather than the markup: with the tier OFF,
// neither page may produce a single 4xx/5xx on /api/*. It would have failed
// before the fix and passes only while the entitlement is READ
// (/api/admin/analytics/entitlements) instead of probed.
//
// What it deliberately does NOT relax: the gates. The last block re-asserts that
// the three premium endpoints still answer 403 to this same unentitled admin —
// the client change decides what is drawn, never what is served.
function collectFailures(page: Page) {
  const failures: string[] = [];
  page.on('response', (res) => {
    // Only our own API surface: a stray asset 404 from the dev server is not
    // what this test is about.
    if (res.url().includes('/api/') && res.status() >= 400) {
      failures.push(`[HTTP ${res.status()}] ${new URL(res.url()).pathname}`);
    }
  });
  return failures;
}

test('an unentitled admin opens analytics with no failed requests', async ({ page }) => {
  const adminEmail = uniqueEmail('gate-probe-admin');
  const pw = 'GateProbe123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Gate Probe Admin');

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');

    // The tier is off by default; make that explicit so the test does not
    // depend on whatever a previous spec left behind.
    expect((await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } })).ok()).toBeTruthy();

    // --- /admin/analytics -------------------------------------------------
    const analyticsFailures = collectFailures(page);
    await page.goto('/admin/analytics');
    // The locked panel is the marker that the entitlement answer has arrived,
    // so waiting for it also waits for every request this page makes.
    await expect(page.getByTestId('premium-analytics-locked')).toBeVisible({ timeout: 15_000 });
    // The premium cards and the export/report controls stay away.
    await expect(page.getByTestId('cohort-compare')).toHaveCount(0);
    await expect(page.getByTestId('benchmark')).toHaveCount(0);
    await expect(page.getByTestId('source-conversion')).toHaveCount(0);
    await expect(page.getByTestId('full-report-link')).toHaveCount(0);
    expect(analyticsFailures).toEqual([]);

    // --- /admin/analytics/report ------------------------------------------
    const reportFailures = collectFailures(page);
    await page.goto('/admin/analytics/report');
    await expect(page.getByTestId('report-locked')).toBeVisible({ timeout: 15_000 });
    expect(reportFailures).toEqual([]);

    // --- the server gate is untouched -------------------------------------
    // Same session, same locked tier: every premium endpoint still refuses.
    for (const path of ['/api/admin/analytics/cohorts', '/api/admin/analytics/sources', '/api/admin/analytics/benchmark']) {
      const res = await page.request.get(path);
      expect(res.status(), path).toBe(403);
      expect((await res.json()).error).toBe('feature_locked');
    }
    // And the entitlements read that replaced the probe is ADMIN-only and honest.
    const ent = await page.request.get('/api/admin/analytics/entitlements');
    expect(ent.ok()).toBeTruthy();
    expect(await ent.json()).toEqual({ premiumAnalytics: false });
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});

test('an entitled admin still gets the premium cards, and still no failed requests', async ({ page }) => {
  const adminEmail = uniqueEmail('gate-entitled-admin');
  const pw = 'GateEntitled123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Gate Entitled Admin');

  try {
    await signInAndSettle(page, adminEmail, pw, '/admin');
    expect((await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } })).ok()).toBeTruthy();

    const failures = collectFailures(page);
    await page.goto('/admin/analytics');
    // Behaviour with the tier ON is unchanged (#540): the cohort card renders
    // and the two full-report controls are back.
    await expect(page.getByTestId('cohort-compare')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('full-report-link')).toBeVisible();
    await expect(page.getByTestId('full-report-excel')).toBeVisible();
    await expect(page.getByTestId('premium-analytics-locked')).toHaveCount(0);
    expect(failures).toEqual([]);

    const reportFailures = collectFailures(page);
    await page.goto('/admin/analytics/report');
    await expect(page.getByTestId('full-report')).toBeVisible({ timeout: 15_000 });
    expect(reportFailures).toEqual([]);
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});

test('a mentor cannot read the analytics entitlements', async ({ page }) => {
  const mentorEmail = uniqueEmail('gate-probe-mentor');
  const pw = 'GateMentor123';
  await seedUser(mentorEmail, pw, 'MENTOR', 'Gate Probe Mentor');
  try {
    await signInAndSettle(page, mentorEmail, pw, '/mentor');
    expect((await page.request.get('/api/admin/analytics/entitlements')).status()).toBe(401);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
