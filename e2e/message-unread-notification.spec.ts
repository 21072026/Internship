import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

/**
 * #1464 — reading a message retires the notification it produced.
 *
 * The reported bug: after opening a thread (and even after answering it), the
 * blue "new message from X" row was still sitting unread in the bell and on
 * /notifications, because the app kept two independent unread signals for the
 * same event and clearing one did not clear the other.
 */

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

test('opening a thread clears its unread message notification', async ({ page }) => {
  const mentorEmail = uniqueEmail('unreadmentor');
  const menteeEmail = uniqueEmail('unreadmentee');
  const pw = 'UnreadPass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Unread Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Unread Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  await prisma.message.create({
    data: { relationId: relation.id, senderId: mentee.id, body: 'Is my CV ready to send?' },
  });
  // Exactly what POST /api/messages writes for the recipient: the notification
  // row, linked to the thread it is about. Seeded in the legacy link shape on
  // purpose — a row already sitting in someone's bell predates the conversation
  // layer, and the fix has to reach it too.
  const notification = await prisma.notification.create({
    data: {
      userId: mentor.id,
      type: 'message.new',
      params: { from: 'Unread Mentee' },
      link: `/messages/${relation.id}`,
    },
  });

  try {
    await signIn(page, mentorEmail, pw, '/mentor');

    // Before: the row is unread, so the bell carries a badge.
    expect((await prisma.notification.findUnique({ where: { id: notification.id } }))?.read).toBe(false);

    // Read the thread the way a person does — the relation URL hands over to the
    // pair's conversation (#1156), which is the read that must clear both signals.
    await page.goto(`/messages/${relation.id}`);
    await page.waitForURL((u) => u.pathname.startsWith('/messages/c/'), { timeout: 20_000 });
    await expect(page.getByText(/Is my CV ready to send/)).toBeVisible({ timeout: 15_000 });

    // After: the message counter AND the bell row are both closed.
    await expect
      .poll(
        async () => (await prisma.notification.findUnique({ where: { id: notification.id } }))?.read,
        { timeout: 15_000 },
      )
      .toBe(true);
    expect(
      await prisma.message.count({ where: { relationId: relation.id, readAt: null, senderId: mentee.id } }),
    ).toBe(0);

    // And the header badge is gone rather than holding a stale count.
    await page.goto('/messages');
    await expect(page.getByTestId('messages-unread-badge')).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await prisma.notification.deleteMany({ where: { userId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('the realtime stream answers as an event stream and opens with the unread counts', async ({ page }) => {
  const mentorEmail = uniqueEmail('streammentor');
  const pw = 'StreamPass123';
  await seedUser(mentorEmail, pw, 'MENTOR', 'Stream Mentor');

  try {
    await signIn(page, mentorEmail, pw, '/mentor');

    // Read the stream through the browser's own session rather than an
    // EventSource, so the assertion can be about the bytes on the wire: the
    // content type, the buffering opt-out that makes it work behind nginx, and
    // the opening `ready` frame.
    const probe = await page.evaluate(async () => {
      const res = await fetch('/api/realtime/stream', { headers: { Accept: 'text/event-stream' } });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 10_000;
      while (!text.includes('event: ready') && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
      return {
        status: res.status,
        contentType: res.headers.get('content-type'),
        accelBuffering: res.headers.get('x-accel-buffering'),
        text,
      };
    });

    expect(probe.status).toBe(200);
    expect(probe.contentType).toContain('text/event-stream');
    expect(probe.accelBuffering).toBe('no');
    expect(probe.text).toContain('event: ready');
    // The opening frame carries both counters the header badges are drawn from.
    const data = probe.text.split('event: ready')[1]?.match(/data: (\{.*\})/)?.[1];
    expect(data).toBeTruthy();
    expect(JSON.parse(data!)).toMatchObject({ messages: 0, notifications: 0 });
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});

test('the push subscribe endpoint refuses anonymous callers and rejects junk', async ({ request, page }) => {
  const anon = await request.post('/api/push/subscribe', { data: { endpoint: 'https://example.com/x' } });
  expect(anon.status()).toBe(401);

  const mentorEmail = uniqueEmail('pushmentor');
  const pw = 'PushPass123';
  await seedUser(mentorEmail, pw, 'MENTOR', 'Push Mentor');
  try {
    await signIn(page, mentorEmail, pw, '/mentor');
    // A signed-in caller still cannot write a junk row. Without VAPID keys
    // configured the route answers 503 (push disabled) — which is itself the
    // contract: the feature is optional and says so before validating.
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'not-a-url' }),
      });
      return res.status;
    });
    expect([400, 503]).toContain(status);
    expect(await prisma.pushSubscription.count()).toBe(0);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
