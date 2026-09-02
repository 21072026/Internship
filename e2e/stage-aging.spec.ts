import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC G (#420): time-in-stage must be computed from real StatusChange
// transitions and show meaningful per-stage differences — not one uniform
// number for every stage.
test('stage aging reflects real per-stage durations from transitions', async ({ page }) => {
  const mentorEmail = uniqueEmail('sa-mentor');
  const menteeEmail = uniqueEmail('sa-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'SA Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'SA Mentee');
  const now = Date.now();
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      status: 'ACTIVE',
      pipelineStatus: 'INTERVIEW_PENDING_250',
      startDate: new Date(now - 10 * DAY),
    },
  });
  // APPLICATION_100 held for ~2 days (start → first change);
  // APPROVAL_PENDING_220 held for ~5 days (first → second change).
  await prisma.statusChange.createMany({
    data: [
      { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220', changedById: mentor.id, createdAt: new Date(now - 8 * DAY) },
      { relationId: rel.id, fromStatus: 'APPROVAL_PENDING_220', toStatus: 'INTERVIEW_PENDING_250', changedById: mentor.id, createdAt: new Date(now - 3 * DAY) },
    ],
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    const data = await (await page.request.get('/api/admin/analytics/aging')).json();
    const byStage: Record<string, { avgDays: number }> = Object.fromEntries(
      data.stageAging.map((s: { pipelineStatus: string; avgDays: number }) => [s.pipelineStatus, s])
    );

    // Both completed stages are present with the durations we seeded…
    expect(byStage['APPLICATION_100']).toBeTruthy();
    expect(byStage['APPROVAL_PENDING_220']).toBeTruthy();
    // …and they differ (5 days vs 2 days) — not one uniform value.
    expect(byStage['APPROVAL_PENDING_220'].avgDays).toBeGreaterThan(byStage['APPLICATION_100'].avgDays);
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: rel.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

// #1427: the card used to print the completed-visit count as "N candidates",
// so /admin/analytics reported two different figures for the same stage (the
// funnel says who sits there now, aging says who has been through). The payload
// now carries both numbers, and the card names each of them.
test('stage aging separates completed visits from distinct candidates', async ({ page }) => {
  const mentorEmail = uniqueEmail('sav-mentor');
  const menteeEmail = uniqueEmail('sav-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'SAV Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'SAV Mentee');
  const now = Date.now();
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      status: 'ACTIVE',
      pipelineStatus: 'INTERVIEW_PENDING_250',
      startDate: new Date(now - 40 * DAY),
    },
  });
  // ONE candidate visiting APPLICATION_100 TWICE: 100 → 250 → 100 → 250.
  await prisma.statusChange.createMany({
    data: [
      { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', changedById: mentor.id, createdAt: new Date(now - 36 * DAY) },
      { relationId: rel.id, fromStatus: 'INTERVIEW_PENDING_250', toStatus: 'APPLICATION_100', changedById: mentor.id, createdAt: new Date(now - 30 * DAY) },
      { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: 'INTERVIEW_PENDING_250', changedById: mentor.id, createdAt: new Date(now - 24 * DAY) },
    ],
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    const data = await (await page.request.get('/api/admin/analytics/aging')).json();
    const rows: { pipelineStatus: string; visits: number; candidates: number }[] = data.stageAging;
    // Every row: a visit count can never be below the number of people behind it.
    for (const r of rows) {
      expect(r.visits).toBeGreaterThanOrEqual(r.candidates);
    }
    // Our re-entering mentee adds 2 visits but only 1 candidate, so on this
    // stage the two numbers MUST differ — whatever else the database holds.
    const application = rows.find((r) => r.pipelineStatus === 'APPLICATION_100');
    expect(application).toBeTruthy();
    expect(application!.visits).toBeGreaterThan(application!.candidates);

    // The card renders both, each with its own label.
    await page.goto('/admin/analytics');
    const row = page.getByTestId('stage-aging-row-APPLICATION_100');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(/transitions|geçiş|Übergänge/);
    await expect(row).toContainText(/distinct candidates|ayrı aday|verschiedene Kandidaten/);
    // …and the card states on the page (not in a hover-only title, which a
    // touch device never shows) why neither number is the funnel's count.
    await expect(page.getByTestId('stage-aging-hint')).toBeVisible();
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: rel.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
