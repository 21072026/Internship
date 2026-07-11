import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #594: the admin support queue at /admin/support — every ticket is visible,
// a reply moves the ticket to IN_PROGRESS and takes assignment, and status
// transitions notify the requester.
test('admin queue: reply takes assignment and IN_PROGRESS, close notifies the requester', async ({ browser }) => {
  const userEmail = uniqueEmail('supq-user');
  const adminEmail = uniqueEmail('supq-admin');
  const pw = 'SupportQueue123';
  const user = await seedUser(userEmail, pw, 'MENTEE', 'Queue User');
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'Queue Admin');

  const userCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  try {
    // The user opens a ticket.
    const userPage = await userCtx.newPage();
    await userPage.goto('/auth/signin');
    await userPage.fill('input[type="email"], input[name="email"]', userEmail);
    await userPage.fill('input[type="password"]', pw);
    await userPage.click('button[type="submit"]');
    await userPage.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
    const created = await userPage.request.post('/api/support', { data: { body: 'My internship dates look wrong.' } });
    expect(created.status()).toBe(201);
    const { ticketId } = await created.json();

    // Admin signs in and sees the ticket in the queue UI.
    const adminPage = await adminCtx.newPage();
    await adminPage.goto('/auth/signin');
    await adminPage.fill('input[type="email"], input[name="email"]', adminEmail);
    await adminPage.fill('input[type="password"]', pw);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await adminPage.goto('/admin/support');
    await expect(adminPage.getByTestId('support-filters')).toBeVisible({ timeout: 10_000 });
    const row = adminPage.getByTestId(`admin-ticket-${ticketId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText(userEmail)).toBeVisible();

    // Expand the ticket and reply from the UI.
    await row.locator('button').first().click();
    await expect(adminPage.getByTestId('admin-reply-input')).toBeVisible();
    await adminPage.getByTestId('admin-reply-input').fill('Thanks — we are checking the dates now.');
    await adminPage.getByTestId('admin-reply-send').click();
    await expect(row.getByText('checking the dates now', { exact: false })).toBeVisible({ timeout: 10_000 });

    // Reply side-effects: IN_PROGRESS, assigned to the replying admin,
    // requester message marked read, requester notified. Poll the DB rather
    // than asserting instantly — the reply bubble can render before the
    // request's follow-up writes are committed.
    await expect
      .poll(async () => (await prisma.supportTicket.findUnique({ where: { id: ticketId } }))?.status, { timeout: 10_000 })
      .toBe('IN_PROGRESS');
    expect((await prisma.supportTicket.findUnique({ where: { id: ticketId } }))!.assignedAdminId).toBe(admin.id);
    await expect
      .poll(() => prisma.supportMessage.count({ where: { ticketId, senderId: user.id, readAt: null } }), { timeout: 10_000 })
      .toBe(0);
    await expect
      .poll(() => prisma.notification.count({ where: { userId: user.id, type: 'support' } }), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);

    // The user sees the admin reply in their pinned chat.
    const userView = await (await userPage.request.get('/api/support')).json();
    const mine = (userView.tickets as { id: string; messages: { body: string }[] }[]).find((tk) => tk.id === ticketId);
    expect(mine!.messages.some((m) => m.body.includes('checking the dates'))).toBe(true);

    // Close via API; requester is notified and closedAt is set.
    const closed = await adminPage.request.put('/api/admin/support', { data: { ticketId, status: 'CLOSED' } });
    expect(closed.ok()).toBeTruthy();
    const afterClose = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
    expect(afterClose!.status).toBe('CLOSED');
    expect(afterClose!.closedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { userId: user.id, type: 'support' } })).toBeGreaterThanOrEqual(2);

    // The CLOSED filter shows it; a non-admin is rejected by the API.
    const filtered = await (await adminPage.request.get('/api/admin/support?status=CLOSED')).json();
    expect((filtered.tickets as { id: string }[]).some((tk) => tk.id === ticketId)).toBe(true);
    expect((await userPage.request.get('/api/admin/support')).status()).toBe(401);
  } finally {
    await userCtx.close();
    await adminCtx.close();
    await prisma.supportMessage.deleteMany({ where: { ticket: { requesterId: user.id } } });
    await prisma.supportTicket.deleteMany({ where: { requesterId: user.id } });
    await cleanupByEmail(userEmail);
    await cleanupByEmail(adminEmail);
  }
});
