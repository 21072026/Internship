import { test, expect, type Page } from '@playwright/test';
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
 * #1425 / #1890 — every bar in the Trends chart rendered at 0px.
 *
 * The old track sized its bars with CSS percentages, which compute to `auto`
 * (0px) unless an ancestor has a definite height; it collapsed once and was held
 * up by a pinned pixel row. The chart is SVG now (src/components/charts), its
 * rects sized by a scale over the measured container — so the invariant is the
 * scale itself: every bar's pixels are its value's share of the plot, and the
 * largest value fills the plot. Checked on first load, after a viewport resize,
 * and after a client-side navigation back into the page — the three ways a
 * layout can be measured wrong.
 */
async function readBars(page: Page) {
  const chart = page.getByTestId('analytics-trend-chart');
  await expect(chart).toBeVisible({ timeout: 15_000 });
  // The chart library is a dynamic import: wait for its marks, not the box.
  await expect(chart.locator('[data-testid^="trend-bar-new-"]').first()).toBeAttached({ timeout: 15_000 });
  return chart.evaluate((box) => {
    const svg = box.querySelector('svg')!;
    return {
      svgWidth: svg.getBoundingClientRect().width,
      boxWidth: box.getBoundingClientRect().width,
      bars: Array.from(box.querySelectorAll<SVGRectElement>('[data-testid^="trend-bar-"]')).map((el) => ({
        id: el.dataset.testid ?? '?',
        value: Number(el.dataset.value),
        px: el.getBoundingClientRect().height,
        width: el.getBoundingClientRect().width,
      })),
    };
  });
}

function expectBarsTrue(read: Awaited<ReturnType<typeof readBars>>, when: string) {
  const { bars } = read;
  expect(bars.length, `${when}: the chart rendered no bars at all`).toBeGreaterThan(0);
  expect(read.svgWidth, `${when}: the chart is wider than its box`).toBeLessThanOrEqual(read.boxWidth + 1);
  const max = Math.max(...bars.map((b) => b.value));
  // With a fresh relation and interaction seeded, some bar is non-zero…
  expect(max, `${when}: no bar had a value — the data never reached the chart`).toBeGreaterThan(0);
  const tallest = Math.max(...bars.map((b) => b.px));
  // …and it fills the plot (176px box minus the label and value margins).
  expect(tallest, `${when}: no bar had any height — the chart is empty`).toBeGreaterThan(100);
  for (const bar of bars) {
    expect(bar.width, `${when}: ${bar.id} has no width`).toBeGreaterThan(0);
    const expected = (bar.value / max) * tallest;
    expect(
      Math.abs(bar.px - expected),
      `${when}: ${bar.id} = ${bar.value} of ${max} should be ~${expected.toFixed(1)}px, rendered ${bar.px}px`
    ).toBeLessThan(2);
  }
}

test('every trend bar is its value in real pixels — on load, after a resize, after client-side navigation', async ({ page }) => {
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
    expectBarsTrue(await readBars(page), 'first load');

    const before = (await readBars(page)).svgWidth;
    await page.setViewportSize({ width: 700, height: 900 });
    await expect.poll(async () => (await readBars(page)).svgWidth, { timeout: 5_000 }).not.toBe(before);
    expectBarsTrue(await readBars(page), 'after a resize');

    await page.setViewportSize({ width: 1280, height: 800 }); // the sidebar link is desktop-only
    // Leave and come back through the app's own link, so the page mounts in a
    // client-side transition rather than a fresh document.
    await page.goto('/admin');
    await page.locator('a[href="/admin/analytics"]').first().click();
    await page.waitForURL(/\/admin\/analytics$/);
    expectBarsTrue(await readBars(page), 'after client-side navigation');
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
