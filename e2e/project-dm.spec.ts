import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Project-based direct messaging (#768/#769/#770): two mentees who share a
// project — and have no mentorship between them — can find each other in
// /messages and start a DM. Losing the shared project makes the thread
// read-only rather than hiding it.
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

test('project co-members can start a DM, and lose the composer when the project link goes away', async ({ page }) => {
  const aEmail = uniqueEmail('dmpeer-a');
  const bEmail = uniqueEmail('dmpeer-b');
  const ownerEmail = uniqueEmail('dmowner');
  const pw = 'DmPass123';
  const owner = await seedUser(ownerEmail, pw, 'MENTOR', 'DM Owner');
  const peerA = await seedUser(aEmail, pw, 'MENTEE', 'Peer Alpha');
  const peerB = await seedUser(bEmail, pw, 'MENTEE', 'Peer Bravo');

  const project = await prisma.project.create({
    data: { name: 'DM Shared Project', ownerType: 'MENTOR', ownerUserId: owner.id },
  });
  // Both peers are members — the only thing linking them (no mentorship).
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, userId: peerA.id, role: 'MENTEE' },
      { projectId: project.id, userId: peerB.id, role: 'MENTEE' },
    ],
  });

  try {
    await signIn(page, aEmail, pw, '/portal');
    await page.goto('/messages');

    // The co-member is offered as a "new chat" candidate.
    await page.getByTestId('new-chat-toggle').click();
    const candidate = page.getByTestId('new-chat-candidate').filter({ hasText: 'Peer Bravo' });
    await expect(candidate).toBeVisible({ timeout: 10_000 });
    await candidate.click();

    // Landing on the conversation route means create-or-get succeeded.
    await page.waitForURL((u) => u.pathname.startsWith('/messages/c/'), { timeout: 20_000 });
    const conversationId = new URL(page.url()).pathname.split('/').pop()!;

    // Send a message through the shared thread UI.
    // Target test ids, not localized labels — the suite can run in any locale.
    await page.getByTestId('message-input').fill('Hello from the same project!');
    await page.getByTestId('message-send').click();
    await expect(page.getByText('Hello from the same project!')).toBeVisible({ timeout: 10_000 });

    // Stored against the conversation, not a mentorship relation.
    const stored = await prisma.message.findFirst({ where: { conversationId }, select: { relationId: true } });
    expect(stored).not.toBeNull();
    expect(stored!.relationId).toBeNull();

    // Back in the inbox the DM now appears as a thread.
    await page.goto('/messages');
    await expect(page.locator('a[href^="/messages/c/"]').filter({ hasText: 'Peer Bravo' })).toBeVisible({
      timeout: 10_000,
    });

    // Remove A from the project: history stays readable, the composer goes.
    await prisma.projectMember.deleteMany({ where: { projectId: project.id, userId: peerA.id } });
    await page.goto(`/messages/c/${conversationId}`);
    await expect(page.getByText('Hello from the same project!')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('thread-readonly')).toBeVisible();
    await expect(page.getByTestId('message-input')).toHaveCount(0);

    // And the server refuses a new message even if the client is bypassed.
    const res = await page.request.post('/api/messages', {
      data: { conversationId, body: 'should not land' },
    });
    expect(res.status()).toBe(403);
  } finally {
    await prisma.message.deleteMany({ where: { conversation: { participants: { some: { userId: peerA.id } } } } });
    await prisma.conversation.deleteMany({ where: { participants: { some: { userId: peerA.id } } } });
    await prisma.projectMember.deleteMany({ where: { projectId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
    await cleanupByEmail(aEmail);
    await cleanupByEmail(bEmail);
    await cleanupByEmail(ownerEmail);
  }
});
