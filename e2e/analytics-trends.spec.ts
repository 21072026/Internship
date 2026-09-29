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

/**
 * #1501 / #1484 — the trends chart was twelve bars of zero again, and this time
 * the layout fix from #1425 was still working: the rows had height, the
 * percentages became pixels, the percentages were just all 0.
 *
 * The screen's range presets send `to` as `YYYY-MM-DD`, and `new Date(
 * '2026-09-23')` is that day's FIRST instant. Used as an `lte` bound it
 * excluded everything that happened *during* the day the admin picked —
 * including today, on the default "6m" preset. Locally that is invisible
 * (older rows keep the chart full); in a CI shard, where the database holds
 * nothing but rows the specs seeded today, every bucket read zero.
 *
 * Asserted against the API rather than the chart, and as a comparison rather
 * than a threshold: the two calls are seconds apart over the same rows, so the
 * current month's count must agree. Any "> 0" assertion passes on a database
 * with history in it, which is exactly how this shipped.
 */
test('a bounded range includes the day it ends on', async ({ page }) => {
  const email = uniqueEmail('at-today-admin');
  const pw = 'AdminPass123';
  await seedUser(email, pw, 'ADMIN', 'AT Today Admin');
  const mentor = await seedUser(uniqueEmail('at-today-mentor'), pw, 'MENTOR', 'AT Today Mentor');
  const mentee = await seedUser(uniqueEmail('at-today-mentee'), pw, 'MENTEE', 'AT Today Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', startDate: new Date() },
  });
  await prisma.interactionLog.create({
    data: { relationId: relation.id, type: 'Meeting', notes: 'Logged today', date: new Date() },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // The exact query string the "6m" preset builds (page.tsx `rangeQuery`).
    const to = new Date();
    const from = new Date(to);
    from.setMonth(from.getMonth() - 6);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    const open = await (await page.request.get('/api/admin/analytics')).json();
    const bounded = await (
      await page.request.get(`/api/admin/analytics?from=${iso(from)}&to=${iso(to)}`)
    ).json();

    // Same rows, so the month both calls end in must carry the same counts.
    // The unbounded call's `to` is `now`, which has always included today.
    const month = open.trends.months[open.trends.months.length - 1];
    expect(bounded.trends.months[bounded.trends.months.length - 1]).toBe(month);
    const last = (t: { newRelations: number[]; interactions: number[] }) => ({
      newRelations: t.newRelations[t.newRelations.length - 1],
      interactions: t.interactions[t.interactions.length - 1],
    });
    expect(last(bounded.trends), `${month}: a bounded range must not drop today's rows`).toEqual(
      last(open.trends)
    );
    // And the seeded rows are in there, so the comparison is not two zeros.
    expect(last(open.trends).newRelations).toBeGreaterThan(0);
    expect(last(open.trends).interactions).toBeGreaterThan(0);
  } finally {
    await prisma.interactionLog.deleteMany({ where: { relationId: relation.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    await cleanupByEmail(email);
  }
});
