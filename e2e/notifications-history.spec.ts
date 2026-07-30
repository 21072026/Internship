import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
}

test('a user only ever sees their own notifications on /notifications, with working status and type filters', async ({ page }) => {
  const meEmail = uniqueEmail('notifhist-me');
  const otherEmail = uniqueEmail('notifhist-other');
  const me = await seedUser(meEmail, 'MenteePass123', 'MENTEE', 'Notif History Me');
  const other = await seedUser(otherEmail, 'MenteePass123', 'MENTEE', 'Notif History Other');
  const suffix = Date.now().toString(36);

  try {
    const unreadMessage = `Needs attention msg ${suffix}`;
    const readMessage = `Already seen msg ${suffix}`;
    const unreadDeadline = `Pending due date ${suffix}`;
    const otherOnly = `Other user only notif ${suffix}`;

    await prisma.notification.createMany({
      data: [
        { userId: me.id, type: 'message', text: unreadMessage, read: false },
        { userId: me.id, type: 'message', text: readMessage, read: true },
        { userId: me.id, type: 'deadline', text: unreadDeadline, read: false },
        { userId: other.id, type: 'message', text: otherOnly, read: false },
      ],
    });

    await signIn(page, meEmail, 'MenteePass123');
    await page.goto('/notifications');

    const list = page.getByTestId('notifications-list');
    await expect(list).toBeVisible();

    // Isolation: never see another user's notification, even unfiltered.
    await expect(page.getByText(otherOnly)).toHaveCount(0);

    // All three of my own notifications are visible by default.
    await expect(list.getByText(unreadMessage)).toBeVisible();
    await expect(list.getByText(readMessage)).toBeVisible();
    await expect(list.getByText(unreadDeadline)).toBeVisible();

    // Status filter: "Unread" hides the read one.
    await page.getByLabel('Status').selectOption('unread');
    await expect(list.getByText(unreadMessage)).toBeVisible();
    await expect(list.getByText(unreadDeadline)).toBeVisible();
    await expect(list.getByText(readMessage)).toHaveCount(0);

    // Type filter: combined with the unread status filter, only the deadline one remains.
    await page.getByLabel('Type').selectOption('deadline');
    await expect(list.getByText(unreadDeadline)).toBeVisible();
    await expect(list.getByText(unreadMessage)).toHaveCount(0);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [me.id, other.id] } } });
    await cleanupByEmail(meEmail);
    await cleanupByEmail(otherEmail);
  }
});

test('/notifications shows a total count badge, a paginated range readout, and lets you clear active filters', async ({ page }) => {
  const email = uniqueEmail('notifhist-ux');
  const me = await seedUser(email, 'MenteePass123', 'MENTEE', 'Notif History UX');
  const suffix = Date.now().toString(36);

  try {
    const unread1 = `UX unread one ${suffix}`;
    const unread2 = `UX unread two ${suffix}`;
    const alreadySeen = `UX already seen ${suffix}`;

    await prisma.notification.createMany({
      data: [
        { userId: me.id, type: 'message', text: unread1, read: false },
        { userId: me.id, type: 'deadline', text: unread2, read: false },
        { userId: me.id, type: 'message', text: alreadySeen, read: true },
      ],
    });

    await signIn(page, email, 'MenteePass123');
    await page.goto('/notifications');

    const list = page.getByTestId('notifications-list');
    await expect(list).toBeVisible();

    // Total count badge and the "1–3 / 3" pagination range readout.
    await expect(page.getByText('3 notifications', { exact: true })).toBeVisible();
    await expect(page.getByText('1–3 / 3 notifications')).toBeVisible();

    // No active filters yet: the clear-filters action is not shown.
    const clearButton = page.getByRole('button', { name: 'Clear filters' });
    await expect(clearButton).toHaveCount(0);

    // Filtering hides the read notification and reveals the clear-filters action.
    await page.getByLabel('Status').selectOption('unread');
    await expect(list.getByText(alreadySeen)).toHaveCount(0);
    await expect(clearButton).toBeVisible();

    // Clearing filters restores the full list and hides the action again.
    await clearButton.click();
    await expect(list.getByText(alreadySeen)).toBeVisible();
    await expect(clearButton).toHaveCount(0);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: me.id } });
    await cleanupByEmail(email);
  }
});

test('/notifications shows an empty state for a user with no notifications', async ({ page }) => {
  const email = uniqueEmail('notifhist-empty');
  await seedUser(email, 'MenteePass123', 'MENTEE', 'Notif History Empty');

  try {
    await signIn(page, email, 'MenteePass123');
    await page.goto('/notifications');
    await expect(page.getByText('No notifications')).toBeVisible();
    await expect(page.getByTestId('notifications-list')).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});

test('GET /api/notifications enforces the caller\'s own userId and paginates', async ({ page }) => {
  const meEmail = uniqueEmail('notifhist-page');
  const otherEmail = uniqueEmail('notifhist-page-other');
  const me = await seedUser(meEmail, 'MenteePass123', 'MENTEE', 'Notif Page Me');
  const other = await seedUser(otherEmail, 'MenteePass123', 'MENTEE', 'Notif Page Other');

  try {
    await prisma.notification.createMany({
      data: Array.from({ length: 22 }, (_, i) => ({ userId: me.id, type: 'message', text: `Page notif ${i}`, read: false })),
    });
    await prisma.notification.create({ data: { userId: other.id, type: 'message', text: 'Not mine' } });

    await signIn(page, meEmail, 'MenteePass123');

    const page1 = await page.request.get('/api/notifications?page=1&pageSize=20');
    expect(page1.ok()).toBeTruthy();
    const d1 = await page1.json();
    expect(d1.total).toBe(22);
    expect(d1.items).toHaveLength(20);
    expect(d1.items.every((n: { text: string }) => n.text !== 'Not mine')).toBeTruthy();

    const page2 = await page.request.get('/api/notifications?page=2&pageSize=20');
    const d2 = await page2.json();
    expect(d2.items).toHaveLength(2);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: { in: [me.id, other.id] } } });
    await cleanupByEmail(meEmail);
    await cleanupByEmail(otherEmail);
  }
});
