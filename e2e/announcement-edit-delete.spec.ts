import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #1162: a published announcement used to be permanent — POST was the resource's
// only verb, so a typo lived forever and a superseded broadcast stayed on
// everyone's screen. Editing and deleting now reach the copy that was already
// delivered, via Notification.announcementId.
test('an admin can correct a published announcement, and the correction reaches the bell', async ({ page }) => {
  const adminEmail = uniqueEmail('annedit-admin');
  const menteeEmail = uniqueEmail('annedit-mentee');
  const stamp = Date.now().toString(36);
  const original = `Typo anouncement ${stamp}`;
  const corrected = `Fixed announcement ${stamp}`;
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Edit Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Ann Edit Mentee');

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    const posted = await page.request.post('/api/admin/announcements', { data: { text: original } });
    expect(posted.ok()).toBeTruthy();

    const record = await prisma.announcement.findFirstOrThrow({ where: { text: original } });

    // The broadcast tagged its notifications with the announcement id — that is
    // what makes the edit below reach them.
    const before = await prisma.notification.findFirst({
      where: { userId: mentee.id, announcementId: record.id },
    });
    expect(before?.text).toBe(original);

    await gotoSettled(page, '/admin/announcements');
    await page.getByTestId(`announcement-edit-${record.id}`).click();
    await page.getByTestId('announcement-edit-text').fill(corrected);
    const patchDone = page.waitForResponse(
      (r) => r.url().includes(`/api/admin/announcements/${record.id}`) && r.request().method() === 'PATCH'
    );
    await page.getByTestId('announcement-edit-save').click();
    await patchDone;

    await expect(page.getByText(corrected)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(original)).toHaveCount(0);

    // The row already sitting in the mentee's bell is rewritten, not duplicated.
    const after = await prisma.notification.findMany({
      where: { userId: mentee.id, announcementId: record.id },
    });
    expect(after).toHaveLength(1);
    expect(after[0].text).toBe(corrected);
  } finally {
    await prisma.announcement.deleteMany({ where: { text: { in: [original, corrected] } } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('deleting an announcement takes its notifications with it', async ({ page }) => {
  const adminEmail = uniqueEmail('anndel-admin');
  const menteeEmail = uniqueEmail('anndel-mentee');
  const text = `Delete me ${Date.now().toString(36)}`;
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Del Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Ann Del Mentee');

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    expect((await page.request.post('/api/admin/announcements', { data: { text } })).ok()).toBeTruthy();
    const record = await prisma.announcement.findFirstOrThrow({ where: { text } });
    expect(
      await prisma.notification.count({ where: { userId: mentee.id, announcementId: record.id } })
    ).toBe(1);

    await gotoSettled(page, '/admin/announcements');
    await page.getByTestId(`announcement-delete-${record.id}`).click();
    const deleteDone = page.waitForResponse(
      (r) => r.url().includes(`/api/admin/announcements/${record.id}`) && r.request().method() === 'DELETE'
    );
    // The confirmation dialog is the gate — a broadcast is not silently removed.
    // Targeted by testid: every history row also has a "Delete" button.
    await page.getByTestId('confirm-dialog-confirm').click();
    await deleteDone;

    await expect(page.getByText(text)).toHaveCount(0);
    expect(await prisma.announcement.findUnique({ where: { id: record.id } })).toBeNull();
    // No orphan rows pointing at an announcement that no longer exists.
    expect(await prisma.notification.count({ where: { announcementId: record.id } })).toBe(0);
  } finally {
    await prisma.announcement.deleteMany({ where: { text } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('a non-admin cannot edit or delete an announcement', async ({ page }) => {
  const adminEmail = uniqueEmail('annauthz-admin');
  const menteeEmail = uniqueEmail('annauthz-mentee');
  const text = `Guarded announcement ${Date.now().toString(36)}`;
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Authz Admin');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Ann Authz Mentee');

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    expect((await page.request.post('/api/admin/announcements', { data: { text } })).ok()).toBeTruthy();
    const record = await prisma.announcement.findFirstOrThrow({ where: { text } });

    await signInAndSettle(page, menteeEmail, 'MenteePass123', '/portal');
    const patch = await page.request.patch(`/api/admin/announcements/${record.id}`, {
      data: { text: 'hijacked' },
    });
    expect(patch.status()).toBe(401);
    const del = await page.request.delete(`/api/admin/announcements/${record.id}`);
    expect(del.status()).toBe(401);

    // Untouched.
    const still = await prisma.announcement.findUnique({ where: { id: record.id } });
    expect(still?.text).toBe(text);
  } finally {
    await prisma.announcement.deleteMany({ where: { text } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
  }
});
