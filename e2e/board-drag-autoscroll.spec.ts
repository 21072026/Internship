import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// #3662: dragging a card towards an edge of the board scrolls the board, so a
// stage that is off-screen ("Won", "Lost") can be reached in one drag. The
// browser's native drag-and-drop does not scroll an inner horizontal box.
//
// Playwright's drag only fires dragover when the mouse moves, while a real
// browser repeats it every ~50ms; the board stops scrolling once dragover goes
// quiet, so the test keeps nudging the pointer at the edge. It stands 40px in
// from the edge: Chromium itself scrolls a box only within a few pixels of it,
// which is what made the board feel stuck.

const PASSWORD = 'BoardAutoScroll123!';

test.use({ viewport: { width: 1024, height: 800 } });

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function nudge(page: Page, x: number, y: number, times = 12) {
  for (let i = 0; i < times; i++) {
    await page.mouse.move(x + (i % 2), y);
    await page.waitForTimeout(40);
  }
}

test('a dragged card scrolls the board at the right edge and back at the left edge', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('board-autoscroll-mentor');
  const menteeEmail = uniqueEmail('board-autoscroll-mentee');
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Autoscroll Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Autoscroll Applicant');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });

  try {
    await signInAndSettle(page, mentorEmail, PASSWORD, '/mentor');
    await gotoSettled(page, '/mentor/board');
    const scroller = page.getByTestId('board-columns');
    await expect(scroller).toBeVisible({ timeout: 20_000 });
    // Every stage at full width, so the board is far wider than the screen.
    await page.getByTestId('board-show-empty').check();
    const scrollLeft = () => scroller.evaluate((el) => el.scrollLeft);
    await expect.poll(() => scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(200);
    expect(await scrollLeft()).toBe(0);

    const card = page.getByTestId('board-card').filter({ hasText: 'Autoscroll Applicant' });
    const cardBox = (await card.boundingBox())!;
    const box = (await scroller.boundingBox())!;
    const y = cardBox.y + cardBox.height / 2;
    await page.mouse.move(cardBox.x + cardBox.width / 2, y);
    await page.mouse.down();
    // Out of the middle first, so the drag starts before we reach the edge.
    await page.mouse.move(box.x + box.width / 2, y, { steps: 5 });
    const middle = await scrollLeft();
    expect(middle).toBe(0);

    await nudge(page, box.x + box.width - 40, y);
    await expect.poll(scrollLeft).toBeGreaterThan(100);
    const far = await scrollLeft();

    // Standing in the middle does not scroll.
    await page.mouse.move(box.x + box.width / 2, y, { steps: 3 });
    await page.waitForTimeout(300);
    const settled = await scrollLeft();
    await page.waitForTimeout(300);
    expect(await scrollLeft()).toBe(settled);
    expect(settled).toBeGreaterThanOrEqual(far);

    await nudge(page, box.x + 40, y);
    await expect.poll(scrollLeft).toBeLessThan(settled);
    await page.mouse.up();
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: rel.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
