import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await gotoSettled(page, '/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('a mentor reaches messages from the header icon and sees their thread', async ({ page }) => {
  const mentorEmail = uniqueEmail('msgmentor');
  const menteeEmail = uniqueEmail('msgmentee');
  const pw = 'MsgPass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Msg Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Msg Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  // An unread incoming message from the mentee.
  await prisma.message.create({
    data: { relationId: relation.id, senderId: mentee.id, body: 'Hello mentor, quick question!' },
  });

  try {
    await signIn(page, mentorEmail, pw, '/mentor');

    // The header messaging shortcut is reachable from anywhere in the shell.
    // (It renders in both the mobile top bar and the desktop strip; target the
    // one visible at this viewport.)
    const icon = page.locator('a[href="/messages"]:visible').first();
    await expect(icon).toBeVisible({ timeout: 10_000 });
    await icon.click();

    await page.waitForURL((u) => u.pathname === '/messages', { timeout: 20_000 });
    // The thread lists the other participant and a preview of the last message.
    // Scoped to the thread row's own link (href starts with /messages/c/) rather
    // than a bare getByText('Msg Mentee'): during the client-side transition from
    // /mentor, React keeps the previous page's DOM on screen until the new page's
    // data is ready, and /mentor renders its own "Msg Mentee" text in the mentor
    // attention queue — an unscoped text match is a strict-mode violation against
    // that stale content, which a visibility timeout does not wait out.
    const threadLink = page.locator('a[href^="/messages/c/"]').filter({ hasText: 'Msg Mentee' });
    await expect(threadLink).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/quick question/i)).toBeVisible();

    // Opening the thread navigates into the pair's one conversation (#1156).
    await threadLink.click();
    await page.waitForURL((u) => u.pathname.startsWith('/messages/c/'), { timeout: 20_000 });
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
