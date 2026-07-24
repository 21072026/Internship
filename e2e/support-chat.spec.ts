import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #593: every user has a pinned "Support" conversation in the messages inbox.
// The first message opens a SupportTicket, further messages join the open
// ticket, and admins are notified. Driven via the authenticated API plus a
// UI pass over /messages and /messages/support.
test('support chat: first message opens a ticket, next one appends, admin is notified', async ({ browser }) => {
  const userEmail = uniqueEmail('sup-user');
  const adminEmail = uniqueEmail('sup-admin');
  const pw = 'SupportPass123';
  const user = await seedUser(userEmail, pw, 'MENTEE', 'Support User');
  const admin = await seedUser(adminEmail, 'x', 'ADMIN', 'Support Admin');

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', userEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // The pinned Support entry is always present in the inbox.
    await page.goto('/messages');
    await expect(page.getByTestId('support-entry')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('support-entry').click();
    await page.waitForURL((u) => u.pathname === '/messages/support', { timeout: 10_000 });
    await expect(page.getByTestId('support-chat')).toBeVisible({ timeout: 10_000 });

    // First message opens a new ticket.
    const first = await page.request.post('/api/support', { data: { body: 'Hello, I need help with my CV upload.' } });
    expect(first.status()).toBe(201);
    const firstJson = await first.json();
    expect(firstJson.isNew).toBe(true);

    // Second message joins the same (still open) ticket.
    const second = await page.request.post('/api/support', { data: { body: 'One more detail: it fails on PDF files.' } });
    expect(second.status()).toBe(201);
    const secondJson = await second.json();
    expect(secondJson.isNew).toBe(false);
    expect(secondJson.ticketId).toBe(firstJson.ticketId);

    // GET returns the ticket with both messages in order.
    const listed = await (await page.request.get('/api/support')).json();
    const ticket = (listed.tickets as { id: string; status: string; messages: { body: string }[] }[])
      .find((tk) => tk.id === firstJson.ticketId);
    expect(ticket).toBeTruthy();
    expect(ticket!.status).toBe('OPEN');
    expect(ticket!.messages).toHaveLength(2);
    expect(ticket!.messages[0].body).toContain('CV upload');

    // The chat page renders the sent messages.
    await page.reload();
    await expect(page.getByTestId(`ticket-${firstJson.ticketId}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('it fails on PDF files', { exact: false })).toBeVisible();

    // Sending from the UI also lands in the same ticket.
    await page.getByTestId('support-input').fill('Sent from the chat box.');
    await page.getByTestId('support-send').click();
    await expect(page.getByText('Sent from the chat box.', { exact: false })).toBeVisible({ timeout: 10_000 });
    expect(await prisma.supportMessage.count({ where: { ticketId: firstJson.ticketId } })).toBe(3);

    // Text is optional when at least one valid attachment is present.
    const attachmentOnly = await page.request.post('/api/support', {
      multipart: {
        body: '',
        files: {
          name: 'details.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4 support details'),
        },
      },
    });
    expect(attachmentOnly.status()).toBe(201);

    // Text and attachments can still be sent together.
    const textAndAttachment = await page.request.post('/api/support', {
      multipart: {
        body: 'Screenshot and details attached.',
        files: {
          name: 'screenshot.png',
          mimeType: 'image/png',
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        },
      },
    });
    expect(textAndAttachment.status()).toBe(201);

    // Only a truly empty submission is rejected.
    const empty = await page.request.post('/api/support', { data: { body: '   ' } });
    expect(empty.status()).toBe(400);

    // Admins were notified about the new ticket.
    expect(await prisma.notification.count({ where: { userId: admin.id, type: 'support' } })).toBeGreaterThanOrEqual(1);

    // A closed ticket means the next message opens a fresh one.
    await prisma.supportTicket.update({ where: { id: firstJson.ticketId }, data: { status: 'CLOSED', closedAt: new Date() } });
    const reopened = await page.request.post('/api/support', { data: { body: 'New question after closure.' } });
    expect(reopened.status()).toBe(201);
    const reopenedJson = await reopened.json();
    expect(reopenedJson.isNew).toBe(true);
    expect(reopenedJson.ticketId).not.toBe(firstJson.ticketId);
  } finally {
    await ctx.close();
    await prisma.supportMessage.deleteMany({ where: { ticket: { requesterId: user.id } } });
    await prisma.supportTicket.deleteMany({ where: { requesterId: user.id } });
    await cleanupByEmail(userEmail);
    await cleanupByEmail(adminEmail);
  }
});
