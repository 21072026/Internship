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

// The per-group e-mail switches (#1290) live in the same card as the legacy
// in-app list above and write into the same notificationPrefs JSON column, under
// prefixed `email:<group>` keys. Two things have to hold, and only one of them
// is visible: the switch persists, and it does NOT take the legacy keys with it.
// /api/profile REPLACES that column rather than merging, so a UI that posted
// only its own keys would silently wipe every in-app opt-out the user had — a
// data-loss bug nobody would notice for months.
test('an e-mail group opts out through account settings without clobbering the legacy keys', async ({ page }) => {
  const email = uniqueEmail('np-group');
  const user = await seedUser(email, 'UserPass123', 'MENTEE', 'NP Group');

  try {
    // A pre-existing legacy opt-out, recorded the way the older UI records it.
    await prisma.user.update({
      where: { id: user.id },
      data: { notificationPrefs: { documents: false, messages: true } },
    });

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'UserPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/account');
    // Targeted by testid: the group names are full sentences of their own and a
    // `label`/`getByText` locator here would collide with the legacy list in the
    // same card (Playwright's hasText is a case-insensitive substring match).
    const digests = page.getByTestId('email-group-toggle-digests');
    await expect(digests).toBeVisible({ timeout: 15_000 });
    // ENABLED, not merely visible. The switch renders before GET /api/profile
    // answers, and until it does `notifPrefs` is still the empty placeholder —
    // so a click in that window used to PUT `{ 'email:digests': false }` over
    // the top of the whole blob and delete `documents`/`messages` outright. It
    // stays disabled until the stored preferences arrive; this is the assertion
    // that would catch that guard being removed, because `uncheck()` below
    // auto-waits for enabled and would otherwise hide the regression.
    await expect(digests).toBeEnabled({ timeout: 15_000 });
    // Nobody has touched it, so it reads as ON — silence is not consent to stop.
    await expect(digests).toBeChecked();

    // Sign-in and security mail has no switch at all, only an "always sent" row.
    await expect(page.getByTestId('email-group-toggle-account_security')).toHaveCount(0);
    await expect(page.getByTestId('email-group-essential-account_security')).toBeVisible();

    await digests.uncheck();
    await expect
      .poll(async () => {
        const me = await (await page.request.get('/api/profile')).json();
        return me.user.notificationPrefs?.['email:digests'];
      })
      .toBe(false);

    // The legacy keys survived the write, and the opt-out survives a reload.
    const me = await (await page.request.get('/api/profile')).json();
    expect(me.user.notificationPrefs.documents).toBe(false);
    expect(me.user.notificationPrefs.messages).toBe(true);

    await page.reload();
    await expect(page.getByTestId('email-group-toggle-digests')).not.toBeChecked();
    // The legacy `documents: false` resolves forward onto its group, so that
    // switch reads OFF even though no `email:` key was ever written for it.
    await expect(page.getByTestId('email-group-toggle-task_reminders')).not.toBeChecked();
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
 * `unsubscribe.legacyHint` promises users in all three locales that these
 * switches gate the in-app notifications as well as defaulting the e-mail group
 * they map to — this makes the in-app half true.
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

/**
 * A legacy category is still the back-compat default for the e-mail group it
 * maps to (`mentorship` → `mentorship_lifecycle`), and both switch lists live in
 * the same card. `groupPrefs` was resolved once at load and never recomputed on
 * a legacy toggle, so unticking a category left the group switch above it
 * showing the old answer until the page was reloaded — the card contradicting
 * itself about mail that had in fact just been switched off.
 */
test('unticking a legacy category moves the e-mail group switch it maps to, with no reload', async ({ page }) => {
  const email = uniqueEmail('np-resolve');
  await seedUser(email, 'UserPass123', 'MENTEE', 'NP Resolve');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'UserPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/account');
    const group = page.getByTestId('email-group-toggle-mentorship_lifecycle');
    // Enabled, not merely visible: the switches stay disabled until GET
    // /api/profile has answered, and this assertion is what makes the checks
    // below about the *resolved* state rather than the placeholder.
    await expect(group).toBeEnabled({ timeout: 15_000 });
    await expect(group).toBeChecked();

    const legacy = page.locator('label', { hasText: 'Mentorship updates' }).getByRole('checkbox');
    await legacy.uncheck();

    // No page.reload() anywhere in here on purpose — that is the bug.
    await expect(group).not.toBeChecked();
    // Only the mapped group moved; the others are untouched.
    await expect(page.getByTestId('email-group-toggle-digests')).toBeChecked();

    await expect
      .poll(async () => {
        const me = await (await page.request.get('/api/profile')).json();
        return me.user.notificationPrefs?.mentorship;
      })
      .toBe(false);
  } finally {
    await cleanupByEmail(email);
  }
});
