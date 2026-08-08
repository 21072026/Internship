import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// One 1:1 thread per pair (#1156).
//
// A chat with the same person used to be able to exist twice: once as the
// mentorship thread (/messages/<relationId>) and once as a DIRECT conversation
// (/messages/c/<id>), which is what a mentor sees when they write from the
// mentee page one day and from a user card the next. The inbox listed both, so
// the same name appeared twice with half the history behind each row.
//
// This seeds exactly that split state and asserts it collapses into one thread
// holding both sides of the history.
//
// Deliberately NOT tagged @smoke: the PR gate stays small (see CLAUDE.md).

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

test('a mentor sees one thread per mentee, holding both histories', async ({ page }) => {
  const mentorEmail = uniqueEmail('one-mentor');
  const menteeEmail = uniqueEmail('one-mentee');
  const pw = 'OnePass123';
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'One Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Duplicate Mentee');

  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  // Session 1: the legacy mentorship thread.
  await prisma.message.create({
    data: { relationId: rel.id, senderId: mentor.id, body: 'Written in the mentorship thread' },
  });
  // Session 2: a separate DIRECT conversation with the same person — the second
  // chat window the bug report is about.
  const directKey = [mentor.id, mentee.id].sort().join('|');
  const conversation = await prisma.conversation.create({
    data: {
      type: 'DIRECT',
      directKey,
      participants: { create: [{ userId: mentor.id }, { userId: mentee.id }] },
    },
  });
  await prisma.message.create({
    data: { conversationId: conversation.id, senderId: mentor.id, body: 'Written in the direct conversation' },
  });

  try {
    await signIn(page, mentorEmail, pw, '/mentor');
    await page.goto('/messages');

    // Exactly one row for this person, and none of them is the old relation URL.
    const rows = page.locator('a[href^="/messages/c/"]').filter({ hasText: 'Duplicate Mentee' });
    await expect(rows).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(`a[href="/messages/${rel.id}"]`)).toHaveCount(0);

    // Both sessions' messages live in that one thread now.
    await rows.click();
    await page.waitForURL((u) => u.pathname.startsWith('/messages/c/'), { timeout: 20_000 });
    const thread = page.getByTestId('thread-messages');
    await expect(thread.getByText('Written in the mentorship thread')).toBeVisible({ timeout: 10_000 });
    await expect(thread.getByText('Written in the direct conversation')).toBeVisible();

    // The mentorship URL is linked from the mentee card, the portal, notification
    // and digest emails — it keeps working by handing over to that thread.
    await page.goto(`/messages/${rel.id}`);
    await expect(page).toHaveURL(new RegExp(`/messages/c/${conversation.id}$`), { timeout: 20_000 });
  } finally {
    await prisma.message.deleteMany({
      where: { OR: [{ relationId: rel.id }, { conversationId: conversation.id }] },
    });
    await prisma.conversation.deleteMany({ where: { directKey } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
