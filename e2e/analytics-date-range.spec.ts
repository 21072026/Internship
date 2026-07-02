import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC G (#420) — the analytics date-range selector. We seed a relation with an
// interaction and a stage transition on a distinctive historical date (2019-03)
// that no other test touches, so the range filtering is deterministic.
test('analytics honours the ?from/?to date-range window', async ({ page }) => {
  const adminEmail = uniqueEmail('dr-admin');
  const mentorEmail = uniqueEmail('dr-mentor');
  const menteeEmail = uniqueEmail('dr-mentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'DR Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'DR Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'DR Mentee');

  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      startDate: new Date('2019-03-01T00:00:00Z'),
    },
  });
  await prisma.interactionLog.create({
    data: { relationId: rel.id, date: new Date('2019-03-10T00:00:00Z'), notes: 'dr', type: 'MEETING' },
  });
  // A transition out of the initial stage on 2019-03-10 → BASVURU_100 was "left"
  // that day, so it feeds stageAging for any window covering March 2019.
  await prisma.statusChange.create({
    data: {
      relationId: rel.id,
      fromStatus: 'BASVURU_100',
      toStatus: 'ONAY_220',
      changedById: mentor.id,
      createdAt: new Date('2019-03-10T00:00:00Z'),
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Window covering March 2019 → our seeded data is counted.
    const covering = await (
      await page.request.get('/api/admin/analytics?from=2019-01-01&to=2019-06-30')
    ).json();
    expect(covering.range).toEqual({ from: '2019-01-01', to: '2019-06-30' });
    expect(covering.trends.months).toEqual(['2019-01', '2019-02', '2019-03', '2019-04', '2019-05', '2019-06']);
    const marchIdx = covering.trends.months.indexOf('2019-03');
    expect(covering.trends.newRelations[marchIdx]).toBeGreaterThanOrEqual(1);
    expect(covering.trends.interactions[marchIdx]).toBeGreaterThanOrEqual(1);

    // Window NOT covering March 2019 → the seeded month is absent from the series.
    const excluding = await (
      await page.request.get('/api/admin/analytics?from=2020-01-01&to=2020-03-31')
    ).json();
    expect(excluding.range).toEqual({ from: '2020-01-01', to: '2020-03-31' });
    expect(excluding.trends.months).not.toContain('2019-03');

    // Aging honours the window too: the BASVURU_100 duration appears only when
    // the window covers the day it was left (2019-03-10).
    const agingIn = await (
      await page.request.get('/api/admin/analytics/aging?from=2019-01-01&to=2019-06-30')
    ).json();
    const agingOut = await (
      await page.request.get('/api/admin/analytics/aging?from=2020-01-01&to=2020-03-31')
    ).json();
    const countFor = (payload: { stageAging: { pipelineStatus: string; count: number }[] }) =>
      payload.stageAging.find((s) => s.pipelineStatus === 'BASVURU_100')?.count ?? 0;
    expect(countFor(agingIn)).toBeGreaterThan(countFor(agingOut));

    // The UI selector re-queries the API with a date window when changed.
    await page.goto('/admin/analytics');
    // Let the initial (6-month default) load settle before watching for the next.
    await expect(page.getByText(/Trends|Trendler/i).first()).toBeVisible({ timeout: 15_000 });
    const refetch = page.waitForResponse(
      (r) => r.url().includes('/api/admin/analytics?') && r.url().includes('from='),
      { timeout: 10_000 }
    );
    await page.getByLabel(/Date range|Tarih aralığı|Zeitraum/).selectOption('12m');
    await refetch;
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: rel.id } });
    await prisma.statusChange.deleteMany({ where: { relationId: rel.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
