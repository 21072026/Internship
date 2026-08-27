import { test, expect, type Browser } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * #1464 — a message appears in an open thread without a reload.
 *
 * Before this, `MessageThreadView` fetched on mount and after your own send and
 * never again, so the other side of a conversation could type while your screen
 * showed nothing. The live stream (SSE) is what closes that; this spec drives
 * both sides in two independent browser contexts, because a signal that only
 * works inside one session proves nothing.
 */

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signedInPage(browser: Browser, email: string, pw: string, home: string) {
  const context = await browser.newContext({ storageState: './e2e/.state/consent.json' });
  const page = await context.newPage();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
  return { context, page };
}

// Two sign-ins, two contexts and a wait long enough to cover the polling
// fallback do not fit the 60s default — and against the dev server each sign-in
// also pays for a first compile.
test.setTimeout(180_000);

test('a message posted by the other side appears in an open thread with no reload', async ({ browser }) => {
  const mentorEmail = uniqueEmail('rtmentor');
  const menteeEmail = uniqueEmail('rtmentee');
  const pw = 'RealtimePass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Realtime Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Realtime Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  const mentorSide = await signedInPage(browser, mentorEmail, pw, '/mentor');
  const menteeSide = await signedInPage(browser, menteeEmail, pw, '/portal');

  try {
    // The mentor sits in the thread and does not touch it again.
    await mentorSide.page.goto(`/messages/${relation.id}`);
    await mentorSide.page.waitForURL((u) => u.pathname.startsWith('/messages/c/'), { timeout: 20_000 });
    const conversationId = new URL(mentorSide.page.url()).pathname.split('/').pop()!;
    await expect(mentorSide.page.getByTestId('messages-frame')).toBeVisible({ timeout: 15_000 });
    // Wait for the stream to be ESTABLISHED, not merely for the page to render.
    // The server registers the listener while building the response, so having
    // the response headers is proof the mentor is listening — and against the dev
    // server the first hit on this route also pays for compiling it, which is a
    // second or two the publish would otherwise happen inside.
    await mentorSide.page
      .waitForResponse((r) => r.url().includes('/api/realtime/stream') && r.status() === 200, { timeout: 30_000 })
      .catch(() => {
        // Not fatal: with no stream the client polls, and the assertion below
        // still holds — just more slowly.
      });

    // The mentee posts through the real endpoint from their own session, which is
    // what publishes on the bus.
    const posted = await menteeSide.page.evaluate(async (id) => {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: id, body: 'Sent while you were looking at this' }),
      });
      return res.status;
    }, conversationId);
    expect(posted).toBe(201);

    // No reload, no click: the bubble arrives on the stream. Generous timeout so
    // a slow CI box falls back to the poll (20s) rather than failing the assert —
    // either path is a pass for "the thread updates itself".
    await expect(mentorSide.page.getByText('Sent while you were looking at this')).toBeVisible({
      timeout: 30_000,
    });

    // And reading it that way marks it read, exactly as opening the thread does.
    await expect
      .poll(
        async () =>
          prisma.message.count({
            where: { conversationId, senderId: mentee.id, readAt: null },
          }),
        { timeout: 15_000 },
      )
      .toBe(0);
  } finally {
    await mentorSide.context.close();
    await menteeSide.context.close();
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
