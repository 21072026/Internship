import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('analytics returns a 6-month trend series', async ({ page }) => {
  const email = uniqueEmail('at-admin');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'AT Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const data = await (await page.request.get('/api/admin/analytics')).json();
    expect(data.trends).toBeTruthy();
    expect(data.trends.months).toHaveLength(6);
    expect(data.trends.newRelations).toHaveLength(6);
    expect(data.trends.interactions).toHaveLength(6);

    await page.goto('/admin/analytics');
    await expect(page.getByText(/Trends|Trendler/i).first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});

/**
 * #1425 — every bar in the Trends chart rendered at 0px.
 *
 * The data was right; a percentage height sat inside a column with no height of
 * its own, so it computed to `auto` — 0px for an empty div. The month labels
 * kept rendering because text has intrinsic height, which is exactly why this
 * read as a data problem rather than a layout one.
 *
 * The assertion is the layout invariant itself: a bar's rendered pixels must
 * equal its own inline percentage of the row it sits in. That is precisely what
 * was broken (the percentage never became pixels), and unlike comparing against
 * a separately-fetched API response it cannot drift — the page requests its own
 * date range, so a bare /api/admin/analytics call returns a different number of
 * months and the indices do not line up. I tried that first and it produced a
 * confident, wrong failure.
 */
test('every trend bar turns its percentage into real pixels', async ({ page }) => {
  const email = uniqueEmail('at-render-admin');
  const mentorEmail = uniqueEmail('at-render-mentor');
  const menteeEmail = uniqueEmail('at-render-mentee');
  const pw = 'AdminPass123';
  await seedUser(email, pw, 'ADMIN', 'AT Render Admin');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'AT Render Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'AT Render Mentee');
  // A relation started this month plus an interaction, so at least one bar is
  // non-zero however empty the database is.
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', startDate: new Date() },
  });
  await prisma.interactionLog.create({
    data: { relationId: relation.id, type: 'Meeting', notes: 'Trend render check', date: new Date() },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/analytics');
    const chart = page.getByTestId('analytics-trend-chart');
    await expect(chart).toBeVisible({ timeout: 15_000 });

    const bars = await chart.evaluate((track) =>
      Array.from(track.children).flatMap((column) => {
        const row = column.firstElementChild as HTMLElement;
        const rowHeight = row.getBoundingClientRect().height;
        return Array.from(row.children).map((b) => {
          const el = b as HTMLElement;
          return {
            id: el.dataset.testid ?? '?',
            pct: parseFloat(el.style.height) || 0,
            px: el.getBoundingClientRect().height,
            rowHeight,
          };
        });
      })
    );

    expect(bars.length, 'the chart rendered no bars at all').toBeGreaterThan(0);
    // The row itself must have a real height — if it collapses, every bar below
    // is trivially 0 and the percentage assertion would pass vacuously.
    expect(bars[0].rowHeight).toBeGreaterThan(50);

    for (const bar of bars) {
      const expected = (bar.pct / 100) * bar.rowHeight;
      expect(
        Math.abs(bar.px - expected),
        `${bar.id}: style height ${bar.pct}% of a ${bar.rowHeight}px row should be ~${expected.toFixed(1)}px, rendered ${bar.px}px`
      ).toBeLessThan(2);
    }

    // …and the data must actually reach the chart: with a fresh relation and
    // interaction seeded, at least one bar is non-zero and the tallest fills
    // most of the row. Without this a chart of twelve 0% bars would pass.
    const tallest = Math.max(...bars.map((b) => b.px));
    expect(tallest, 'no bar had any height — the chart is empty').toBeGreaterThan(bars[0].rowHeight * 0.5);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(email);
  }
});
