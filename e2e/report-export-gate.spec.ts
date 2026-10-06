import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, setOrgFeature } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// REPORT_EXPORT (#1740): every admin export goes through
// GET /api/admin/export/[dataset], which asks entitled(orgId, 'REPORT_EXPORT')
// server-side. Proven by direct API calls, in an org of its own so no other
// spec's grant can leak in: locked without the entitlement, open with it, and
// the premium sheets of the full report keep their own ADVANCED_ANALYTICS gate.

const PW = 'ExportGate123!';

test.describe('report export gate', () => {
  const stamp = `${Date.now()}`;
  const adminEmail = uniqueEmail('export-gate-admin');
  const mentorEmail = uniqueEmail('export-gate-mentor');
  const menteeEmail = uniqueEmail('export-gate-mentee');
  let orgId = '';
  let menteeId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `Export Gate ${stamp}`, slug: `export-gate-${stamp}` } })).id;
    await seedUser(adminEmail, PW, 'ADMIN', `Export Gate Admin ${stamp}`, orgId);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', `Export Gate Mentor ${stamp}`, orgId);
    const mentee = await seedUser(menteeEmail, PW, 'MENTEE', `Export Gate Candidate ${stamp}`, orgId);
    menteeId = mentee.id;
    await prisma.mentorshipRelation.create({ data: { orgId, mentorId: mentor.id, menteeId: mentee.id } });
  });

  test.afterAll(async () => {
    for (const email of [menteeEmail, mentorEmail, adminEmail]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
  });

  test('locked without REPORT_EXPORT — on the server, and the buttons say so', async ({ page }) => {
    await setOrgFeature(orgId, 'REPORT_EXPORT', false);
    await signInAndSettle(page, adminEmail, PW, '/admin');
    for (const dataset of ['candidates', 'analytics', 'analytics-full', 'contributor-terms']) {
      const res = await page.request.get(`/api/admin/export/${dataset}`);
      expect(res.status(), dataset).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'feature_locked', feature: 'REPORT_EXPORT' });
    }
    // The paged list itself stays free: only the file is sold.
    expect((await page.request.get('/api/candidates')).status()).toBe(200);

    await page.goto('/admin/candidates');
    await expect(page.getByTestId('export-locked-note')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export Excel' })).toBeDisabled();
  });

  test('open with REPORT_EXPORT; the premium sheets keep their own gate', async ({ page }) => {
    await setOrgFeature(orgId, 'REPORT_EXPORT', true);
    await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', false);
    try {
      await signInAndSettle(page, adminEmail, PW, '/admin');
      const candidates = await page.request.get('/api/admin/export/candidates');
      expect(candidates.status()).toBe(200);
      const ids = ((await candidates.json()).candidates as { id: string }[]).map((c) => c.id);
      expect(ids).toContain(menteeId);

      const basic = await (await page.request.get('/api/admin/export/analytics')).json();
      expect(Object.keys(basic).sort()).toEqual(['aging', 'analytics', 'funnel']);

      // Without ADVANCED_ANALYTICS the cohort and source sheets are null, as on the screen.
      const full = await (await page.request.get('/api/admin/export/analytics-full')).json();
      expect(full.cohorts).toBeNull();
      expect(full.sources).toBeNull();
      await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', true);
      const premium = await (await page.request.get('/api/admin/export/analytics-full')).json();
      expect(Array.isArray(premium.sources)).toBe(true);

      expect((await page.request.get('/api/admin/export/contributor-terms')).status()).toBe(200);
      expect((await page.request.get('/api/admin/export/everything')).status()).toBe(404);

      await page.goto('/admin/candidates');
      await expect(page.getByRole('button', { name: 'Export Excel' })).toBeEnabled();
      await expect(page.getByTestId('export-locked-note')).toHaveCount(0);
    } finally {
      await setOrgFeature(orgId, 'ADVANCED_ANALYTICS', false);
    }
  });

  test('a non-admin is refused before the entitlement is even asked', async ({ page }) => {
    await signInAndSettle(page, mentorEmail, PW, '/mentor');
    expect((await page.request.get('/api/admin/export/candidates')).status()).toBe(401);
  });
});
