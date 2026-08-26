import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a user can opt out of individual email categories', async ({ page }) => {
  const email = uniqueEmail('np-user');
  await seedUser(email, 'UserPass123', 'MENTEE', 'NP User');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'UserPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Opt out of message emails only.
    const put = await page.request.put('/api/profile', { data: { notificationPrefs: { messages: false, digest: true } } });
    expect(put.ok()).toBeTruthy();

    const me = await (await page.request.get('/api/profile')).json();
    expect(me.user.notificationPrefs.messages).toBe(false);
    expect(me.user.notificationPrefs.digest).toBe(true);
  } finally {
    await cleanupByEmail(email);
  }
});

// The email-delivery audit (#668) added the `mentorship` and `meetingReminders`
// opt-out categories. Verify they render in the account settings UI and that
// opting out through the UI persists across a reload.
test('the audit categories opt out through the account settings UI', async ({ page }) => {
  const email = uniqueEmail('np-cat');
  await seedUser(email, 'UserPass123', 'MENTEE', 'NP Cat');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'UserPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/account');

    const mentorship = page.locator('label', { hasText: 'Mentorship updates' }).getByRole('checkbox');
    const meetings = page.locator('label', { hasText: 'Meeting reminders' }).getByRole('checkbox');
    // Both audit categories are present and default to ON (opted in).
    await expect(mentorship).toBeVisible();
    await expect(meetings).toBeVisible();
    await expect(mentorship).toBeChecked();

    // Opt out of mentorship emails via the UI (auto-saves to /api/profile).
    await mentorship.uncheck();
    await expect
      .poll(async () => {
        const me = await (await page.request.get('/api/profile')).json();
        return me.user.notificationPrefs?.mentorship;
      })
      .toBe(false);

    // The opt-out survives a reload; unrelated categories stay opted in.
    await page.reload();
    await expect(page.locator('label', { hasText: 'Mentorship updates' }).getByRole('checkbox')).not.toBeChecked();
    await expect(page.locator('label', { hasText: 'Meeting reminders' }).getByRole('checkbox')).toBeChecked();
  } finally {
    await cleanupByEmail(email);
  }
});

/**
 * #1426 — the "Messages" category silences e-mail but not the in-app bell.
 *
 * `notificationCategoryAllowed` and the `notifyIfAllowed` wrapper both exist and
 * both document that a category switch covers every channel; the message paths
 * simply called bare `notify()` four lines above an e-mail branch that did check.
 * `notifCategoriesHint` promises users in all three locales that these switches
 * apply to e-mail and in-app alike — this makes that true.
 */
test('turning Messages off stops the in-app notification too, not only the email', async ({ page }) => {
  const mentorEmail = uniqueEmail('np-msg-mentor');
  const menteeEmail = uniqueEmail('np-msg-mentee');
  const optedInEmail = uniqueEmail('np-msg-optedin');
  const pw = 'NotifPrefs123!';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'NP Msg Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'NP Msg Mentee');
  const optedIn = await seedUser(optedInEmail, pw, 'MENTEE', 'NP Msg OptedIn');
  const optedOutRelation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });
  const controlRelation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: optedIn.id, status: 'ACTIVE' },
  });
  // One mentee opts out; the other is the control, so a test that silenced
  // everything would not pass either.
  await prisma.user.update({ where: { id: mentee.id }, data: { notificationPrefs: { messages: false } } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    for (const relationId of [optedOutRelation.id, controlRelation.id]) {
      const res = await page.request.post('/api/messages', {
        data: { relationId, body: 'Preference check' },
      });
      expect(res.ok(), await res.text()).toBeTruthy();
    }

    // The opted-out mentee gets no bell row…
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentee.id, type: { startsWith: 'message.' } } }), { timeout: 10_000 })
      .toBe(0);
    // …while the message itself was still delivered to the thread. Opting out of
    // the notification is not opting out of the conversation.
    expect(await prisma.message.count({ where: { relationId: optedOutRelation.id } })).toBe(1);

    // The control mentee still gets one, proving the gate is selective.
    await expect
      .poll(async () => prisma.notification.count({ where: { userId: optedIn.id, type: { startsWith: 'message.' } } }), { timeout: 10_000 })
      .toBe(1);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentee.id, optedIn.id] } } });
    await prisma.message.deleteMany({ where: { relationId: { in: [optedOutRelation.id, controlRelation.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: { in: [optedOutRelation.id, controlRelation.id] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(optedInEmail);
    await cleanupByEmail(mentorEmail);
  }
});
