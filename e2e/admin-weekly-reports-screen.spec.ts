import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// /admin/weekly-reports (#1918): the coordinator's compliance matrix. The
// numbers are the compliance rule's (unit-tested, and pinned at the API level
// by admin-weekly-report-compliance.spec.ts); this spec pins the screen — the
// matrix answers the term question with a legend, the chase-up sends ONE
// reminder however often it is clicked, the drill-down is read-only, the
// booklet renders the term, the export downloads, and nothing scrolls sideways
// at 360px in German.

const PW = 'WeeklyScreen123!';
const DAY = 24 * 60 * 60 * 1000;
const STAGE = 'INTERNSHIP_IN_PROGRESS_450';

function monday(offsetWeeks: number) {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7) + offsetWeeks * 7);
  return day;
}

test.describe('admin weekly-reports screen', () => {
  const stamp = `${Date.now()}`;
  const emails = { admin: uniqueEmail('wrs-admin'), mentor: uniqueEmail('wrs-mentor'), intern: uniqueEmail('wrs-intern') };
  const internName = `WRS Intern ${stamp}`;
  let orgId = '';
  let relationId = '';

  test.beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `WRS Org ${stamp}`, slug: `wrs-${stamp}` } });
    orgId = org.id;
    await seedUser(emails.admin, PW, 'ADMIN', `WRS Admin ${stamp}`, org.id);
    const mentor = await seedUser(emails.mentor, PW, 'MENTOR', `WRS Mentor ${stamp}`, org.id);
    const intern = await seedUser(emails.intern, PW, 'MENTEE', internName, org.id);
    const rel = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: intern.id, orgId: org.id, pipelineStatus: STAGE, startDate: monday(-6) },
    });
    relationId = rel.id;
    await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: 'INTERNSHIP_STARTING_300', toStatus: STAGE, createdAt: new Date(monday(-4).getTime() + DAY) } });
    // Owed: weeks -3, -2, -1. One approved, one late, one missing.
    await prisma.weeklyReport.create({ data: { orgId: org.id, relationId: rel.id, weekStart: monday(-3), summary: 'Set up the project (e2e)', hoursSpent: 30, status: 'APPROVED', submittedAt: new Date(monday(-3).getTime() + 4 * DAY), mentorComment: 'Good start (e2e)' } });
    await prisma.weeklyReport.create({ data: { orgId: org.id, relationId: rel.id, weekStart: monday(-2), summary: 'Built the export (e2e)', hoursSpent: 32, status: 'SUBMITTED', submittedAt: new Date(monday(-1).getTime() + 2 * DAY) } });
  });

  test.afterAll(async () => {
    await prisma.weeklyReportReminder.deleteMany({ where: { relationId } });
    for (const email of Object.values(emails)) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
  });

  test('the matrix shows the term, and the chase-up sends one reminder however often it is clicked', async ({ page }) => {
    await signInAndSettle(page, emails.admin, PW, '/admin');
    await page.goto('/admin/weekly-reports');
    const row = page.getByTestId(`weekly-reports-row-${relationId}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId('weekly-reports-legend')).toBeVisible();
    // Three owed weeks: approved, handed in late, missing.
    await expect(row.locator('[data-state]')).toHaveCount(3);
    await expect(row.locator('[data-state="approved"]')).toHaveCount(1);
    await expect(row.locator('[data-state="submitted"][data-late="true"]')).toHaveCount(1);
    await expect(row.locator('[data-state="missing"]')).toHaveCount(1);
    await expect(page.getByTestId(`weekly-reports-rate-${relationId}`)).toHaveText('67%');
    await expect(page.getByTestId('weekly-reports-summary-interns')).toHaveText('1');

    // The search box is the page's own, not AdminNav's sidebar filter.
    await page.getByTestId('weekly-reports-search').fill('nobody-by-this-name');
    await expect(row).toHaveCount(0);
    await page.getByTestId('weekly-reports-search').fill('');

    // Chase-up: select, send, and the row says so.
    await page.getByTestId(`weekly-reports-select-${relationId}`).check();
    await page.getByTestId('weekly-reports-remind').click();
    await expect(page.getByTestId(`weekly-reports-reminded-${relationId}`)).toBeVisible();
    // Already reminded this week: no checkbox to select it again …
    await expect(page.getByTestId(`weekly-reports-select-${relationId}`)).toHaveCount(0);
    // … and a second request for the same week sends nothing.
    const again = await page.request.post('/api/admin/weekly-reports/remind', { data: { relationIds: [relationId] } });
    expect(again.status()).toBe(200);
    expect(await again.json()).toMatchObject({ reminded: [], skipped: [relationId] });
    expect(await prisma.weeklyReportReminder.count({ where: { relationId } })).toBe(1);
    // The chase-up is on the record.
    await expect.poll(() => prisma.activityLog.count({ where: { action: 'admin.weekly_report.chase', actorEmail: emails.admin } })).toBe(2);
  });

  test('the drill-down is read-only and the booklet prints the whole term', async ({ page }) => {
    await signInAndSettle(page, emails.admin, PW, '/admin');
    await page.goto('/admin/weekly-reports');
    await page.getByTestId(`weekly-reports-open-${relationId}`).click();
    const detail = page.getByTestId('weekly-reports-detail');
    await expect(detail.getByTestId('weekly-reports-detail-week')).toHaveCount(3);
    await expect(detail.getByText('Good start (e2e)')).toBeVisible();
    // Nothing to type into: oversight is not editing.
    await expect(detail.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);

    await page.goto(`/weekly-reports/booklet/${relationId}`);
    const booklet = page.getByTestId('weekly-report-booklet');
    await expect(booklet.getByRole('heading', { level: 1 })).toHaveText('Internship report booklet');
    await expect(booklet.getByTestId('booklet-week')).toHaveCount(3);
    await expect(booklet.getByText('Built the export (e2e)')).toBeVisible();
    await expect(booklet.getByTestId('booklet-Total hours')).toHaveText('62');
  });

  test('the export downloads a workbook', async ({ page }) => {
    await signInAndSettle(page, emails.admin, PW, '/admin');
    await page.goto('/admin/weekly-reports');
    await expect(page.getByTestId(`weekly-reports-row-${relationId}`)).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByTestId('weekly-reports-export').click();
    expect((await download).suggestedFilename()).toMatch(/^weekly-reports-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  test.describe('at 360px in German', () => {
    test.use({ viewport: { width: 360, height: 800 } });

    test('the page does not scroll sideways; the week columns scroll in their own container', async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: 'locale', value: 'de', url: baseURL! }]);
      await signInAndSettle(page, emails.admin, PW, '/admin');
      await page.goto('/admin/weekly-reports');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Wochenberichte');
      await expect(page.getByTestId(`weekly-reports-row-${relationId}`)).toBeVisible();
      const widths = await page.evaluate(() => {
        const matrix = document.querySelector('[data-testid="weekly-reports-matrix"]') as HTMLElement;
        return { doc: document.documentElement.scrollWidth, view: window.innerWidth, matrix: matrix.clientWidth };
      });
      expect(widths.doc).toBeLessThanOrEqual(widths.view);
      expect(widths.matrix).toBeLessThanOrEqual(widths.view);
    });
  });
});
