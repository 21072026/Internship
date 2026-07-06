import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

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
    await expect(page.getByText('Msg Mentee')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/quick question/i)).toBeVisible();

    // Opening the thread navigates into the conversation.
    await page.getByText('Msg Mentee').click();
    await page.waitForURL((u) => u.pathname === `/messages/${relation.id}`, { timeout: 20_000 });
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
