import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

/**
 * The mentee detail page's column layout (#1370).
 *
 * The bug: the overview was a `lg:grid-cols-3` grid in which the profile card
 * and the stage history took one column each and *every* working panel below
 * them carried `lg:col-span-2`. Nothing was ever placed in the third column, so
 * from "Interaction Log" downwards the content sat in the left two thirds and
 * the right third of a 1280px screen was empty top to bottom.
 *
 * The fix splits the grid into two real children: a reference sidebar (profile +
 * stage history) placed in the third column, and the working panels spanning the
 * other two. This spec measures that, so it fails on the old markup:
 *   - both columns exist, are visible and start on the same row at `lg`;
 *   - the sidebar sits to the right of the panels and reaches the right edge of
 *     the grid — no leftover dead column;
 *   - the sidebar holds the reference cards, the wide column the working ones;
 *   - on a phone the two stack in one column, profile first, with no sideways
 *     scroll (the rule from mobile-layout-audit.spec.ts).
 */

const password = 'ColumnsPass123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the mentee detail overview uses both columns at desktop widths', async ({ page }) => {
  const mentorEmail = uniqueEmail('cols-mentor');
  const menteeEmail = uniqueEmail('cols-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Columns Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Columns Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  // Real content in the profile card, so an empty state cannot be mistaken for a
  // correctly placed column.
  await prisma.user.update({
    where: { id: mentee.id },
    data: { university: 'Columns University', department: 'Computer Engineering', city: 'Ankara' },
  });

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');

    for (const width of [1280, 1536]) {
      await page.setViewportSize({ width, height: 900 });
      await gotoSettled(page, `/mentor/mentees/${rel.id}`);

      const sidebar = page.getByTestId('mentee-detail-sidebar');
      const main = page.getByTestId('mentee-detail-main');
      await expect(sidebar).toBeVisible({ timeout: 15_000 });
      await expect(main).toBeVisible();

      // The panels render skeletons while they fetch; measuring a half-loaded
      // page is the usual source of flake here.
      await expect
        .poll(async () => page.locator('.animate-pulse').count(), { timeout: 20_000 })
        .toBe(0);

      const sidebarBox = (await sidebar.boundingBox())!;
      const mainBox = (await main.boundingBox())!;
      expect(sidebarBox.width, `sidebar has no width at ${width}px`).toBeGreaterThan(0);
      expect(sidebarBox.height).toBeGreaterThan(0);

      // Side by side, not stacked: the two columns start on the same row…
      expect(Math.abs(sidebarBox.y - mainBox.y)).toBeLessThanOrEqual(2);
      // …with the sidebar to the right of the working panels.
      expect(sidebarBox.x).toBeGreaterThanOrEqual(mainBox.x + mainBox.width - 1);

      // No dead column: the sidebar occupies roughly the last third of the grid
      // and its right edge is the grid's right edge.
      const gridRight = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="mentee-detail-main"]')!.parentElement!;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      const gridWidth = gridRight.right - gridRight.left;
      expect(sidebarBox.width).toBeGreaterThan(gridWidth * 0.2);
      expect(sidebarBox.x + sidebarBox.width).toBeGreaterThanOrEqual(gridRight.right - 2);
      // The working panels are the wide column, and they are wider than the
      // sidebar (2/3 vs 1/3) — this is what the old markup got backwards by
      // leaving the third column unused.
      expect(mainBox.width).toBeGreaterThan(sidebarBox.width);

      // Each column carries the cards it was designed for.
      await expect(sidebar.getByText('Profile', { exact: true })).toBeVisible();
      await expect(sidebar.getByText(/Stage history/i)).toBeVisible();
      await expect(sidebar.getByText('Columns University')).toBeVisible();
      await expect(main.getByText(/Interaction Log/i)).toBeVisible();
    }
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('the same page still stacks in one column on a phone', async ({ page }) => {
  const mentorEmail = uniqueEmail('cols1-mentor');
  const menteeEmail = uniqueEmail('cols1-mentee');
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Columns Phone Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Columns Phone Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    await gotoSettled(page, `/mentor/mentees/${rel.id}`);

    const sidebar = page.getByTestId('mentee-detail-sidebar');
    const main = page.getByTestId('mentee-detail-main');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
    await expect(main).toBeVisible();

    const sidebarBox = (await sidebar.boundingBox())!;
    const mainBox = (await main.boundingBox())!;
    // One column: same left edge, same width, profile above the working panels.
    expect(Math.abs(sidebarBox.x - mainBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(sidebarBox.width - mainBox.width)).toBeLessThanOrEqual(1);
    expect(mainBox.y).toBeGreaterThan(sidebarBox.y);

    // …and the page does not scroll sideways (mobile-layout-audit.spec.ts rule 1).
    const overflow = await page.evaluate(() => {
      const el = document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
