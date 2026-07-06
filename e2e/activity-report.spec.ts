import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('a mentor sees a mentee activity report with their mentee and metrics', async ({ page }) => {
  const mentorEmail = uniqueEmail('rptmentor');
  const menteeEmail = uniqueEmail('rptmentee');
  const pw = 'ReportPass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Report Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Report Mentee');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  // Seed some recent activity: a completed goal + a page view with dwell time.
  const uniquePath = `/portal/report-e2e-${Date.now()}`;
  await prisma.goal.create({ data: { relationId: relation.id, title: 'Finish CV', status: 'DONE', completedAt: new Date() } });
  await prisma.pageView.create({ data: { userId: mentee.id, path: uniquePath, durationSec: 120 } });

  try {
    await signIn(page, mentorEmail, pw, '/mentor');

    // Reach the report from the sidebar nav.
    await page.getByRole('link', { name: 'Mentee Activity' }).first().click();
    await page.waitForURL((u) => u.pathname === '/mentor/mentee-activity', { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: 'Mentee activity' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Report Mentee')).toBeVisible();
    // The seeded page view surfaces in the "most-visited pages" list.
    await expect(page.getByText(uniquePath)).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
