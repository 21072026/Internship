import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * #1006 — a thread on a phone used to be a normal document: the page title, the
 * bubble list (its own `max-h-[55vh]` scroller) and the composer scrolled
 * *together*, so replying meant scrolling the document down and the bubbles up.
 * There was also no way back other than the browser's own button.
 *
 * Geometric assertions (bounding boxes / scroll metrics), not screenshots: the
 * document must not scroll, the composer must be on screen without scrolling, the
 * bubble list must be the thing that scrolls, and the header must navigate.
 */

const IPHONE_13 = { width: 390, height: 664 };

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** Vertical overflow of the document itself — 0 means "no page scroll". */
function documentOverflow(page: Page) {
  return page.evaluate(() =>
    Math.max(
      document.documentElement.scrollHeight - window.innerHeight,
      document.body.scrollHeight - window.innerHeight,
    ),
  );
}

test('mobile: a thread fills the viewport, only the bubble list scrolls', async ({ page }) => {
  const mentorEmail = uniqueEmail('mobchat-mentor');
  const menteeEmail = uniqueEmail('mobchat-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'MobChat Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'MobChat Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  // Enough history that the list overflows a phone screen several times over.
  for (let i = 0; i < 14; i++) {
    await prisma.message.create({
      data: {
        relationId: rel.id,
        senderId: i % 3 === 0 ? mentee.id : mentor.id,
        channel: 'IN_APP',
        body: `Thread message ${i + 1} — long enough to wrap on a narrow screen.`,
      },
    });
  }

  try {
    await page.setViewportSize(IPHONE_13);
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto(`/messages/${rel.id}`);

    const composer = page.getByTestId('message-input');
    await expect(composer).toBeVisible({ timeout: 15_000 });

    // 1. The page itself does not scroll (1px of slack for sub-pixel rounding).
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);

    // 2. The bubble list is the scroller, and it settles on the newest message
    //    (the scroll is animated, hence the poll).
    const list = page.getByTestId('thread-messages');
    expect(
      await list.evaluate((el) => el.scrollHeight - el.clientHeight),
      'the bubble list overflows and scrolls internally',
    ).toBeGreaterThan(50);
    await expect
      .poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
        message: 'the list settles pinned to the newest message',
      })
      .toBeLessThan(8);

    // 3. The frame ends exactly at the bottom of the visible viewport (#1009): its
    //    height must track the *visible* height, not just `100dvh`. Nothing is
    //    hidden here (no system-bar insets in a headless browser), so the two are
    //    equal — a malformed calc()/max-height would show up as a mismatch.
    const frame = await page.getByTestId('messages-frame').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { bottom: Math.round(box.bottom), height: Math.round(box.height), visible: window.innerHeight };
    });
    expect(frame.height, 'frame fills the visible viewport').toBe(frame.visible);
    expect(frame.bottom, 'and its bottom edge lands on it').toBeLessThanOrEqual(frame.visible);

    // 4. The composer is reachable where it stands — no scrolling, nothing on top
    //    of it (Playwright fails the click if another element intercepts it).
    const box = await composer.boundingBox();
    expect(box, 'composer has a box').not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(IPHONE_13.height);
    await composer.click();

    // 5. Scrolling the history does not move the composer.
    await list.evaluate((el) => { el.scrollTop = 0; });
    const afterScroll = await composer.boundingBox();
    expect(afterScroll!.y).toBeCloseTo(box!.y, 0);
    expect(await documentOverflow(page)).toBeLessThanOrEqual(1);

    // 6. The reported bug (#1009): a strip of the viewport is not actually visible
    //    — a system navigation bar drawn over the bottom 48px. Headless Chromium
    //    has no system bars, so the condition is reproduced through the same signal
    //    the shell listens to, and the whole composer must end up inside what is
    //    left. Without the clamp the send button sat 48px below the visible bottom
    //    with nothing to scroll, which is exactly what was reported.
    const HIDDEN = 48;
    await page.evaluate((hidden) => {
      document.documentElement.style.setProperty('--visible-viewport-height', `${window.innerHeight - hidden}px`);
    }, HIDDEN);
    const send = await page.getByTestId('message-send').boundingBox();
    expect(send, 'send button has a box').not.toBeNull();
    expect(send!.y + send!.height, 'the composer stays inside the visible area').toBeLessThanOrEqual(
      IPHONE_13.height - HIDDEN,
    );
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('mobile: the chat header names the thread and navigates out of it', async ({ page }) => {
  const mentorEmail = uniqueEmail('mobnav-mentor');
  const menteeEmail = uniqueEmail('mobnav-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'MobNav Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'MobNav Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await page.setViewportSize(IPHONE_13);
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto(`/messages/${rel.id}`);

    // The header is the thread's title on mobile — the other party's name.
    await expect(page.getByTestId('messages-header-title')).toHaveText('MobNav Mentee', { timeout: 15_000 });

    // Back goes to the inbox, and the header retitles itself there.
    await page.getByTestId('messages-back').click();
    await expect(page).toHaveURL(/\/messages$/);
    await expect(page.getByTestId('messages-header-title')).toHaveText('Messages');

    // From the inbox, back leaves the messages area for the role's home.
    await page.getByTestId('messages-back').click();
    await expect(page).toHaveURL(/\/mentor/);

    // The home shortcut works from inside a thread too.
    await page.goto(`/messages/${rel.id}`);
    await page.getByTestId('messages-home').click();
    await expect(page).toHaveURL(/\/mentor/);
  } finally {
    await prisma.message.deleteMany({ where: { relationId: rel.id } });
    await prisma.notification.deleteMany({ where: { userId: { in: [mentor.id, mentee.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('the messages routes opt into safe-area insets, other routes do not', async ({ page }) => {
  const email = uniqueEmail('vpfit-mentor');
  await seedUser(email, 'MentorPass123', 'MENTOR', 'ViewportFit Mentor');

  const viewportMeta = () =>
    page.locator('meta[name="viewport"]').getAttribute('content');

  try {
    await page.setViewportSize(IPHONE_13);
    await signInAndSettle(page, email, 'MentorPass123', '/mentor');

    // `viewport-fit=cover` is what makes env(safe-area-inset-*) report the real
    // system-bar insets the chat frame subtracts (#1009) — and it is deliberately
    // scoped to /messages, since those are the only screens that reserve them.
    expect(await viewportMeta()).not.toContain('viewport-fit=cover');

    await page.goto('/messages');
    await expect(page.getByTestId('messages-frame')).toBeVisible({ timeout: 15_000 });
    expect(await viewportMeta()).toContain('viewport-fit=cover');
  } finally {
    await cleanupByEmail(email);
  }
});

test('desktop keeps the page heading and the plain document flow', async ({ page }) => {
  const mentorEmail = uniqueEmail('deskchat-mentor');
  const menteeEmail = uniqueEmail('deskchat-mentee');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'DeskChat Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'DeskChat Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto(`/messages/${rel.id}`);

    await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible({ timeout: 15_000 });
    // The mobile-only header title is not in the DOM at all at this width.
    await expect(page.getByTestId('messages-header-title')).toHaveCount(0);
    await expect(page.getByTestId('messages-home')).toHaveCount(0);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
