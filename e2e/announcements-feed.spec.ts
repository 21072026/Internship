import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #920: admin broadcasts fan out to every active user (see POST
// /api/admin/announcements — there's no per-role/org targeting), so a mentee
// and a mentor should both see a freshly-sent announcement on their dashboard
// card and on the shared /announcements history page, reading straight from
// the Announcement table (independent of the notification bell).
test('an admin announcement shows up in the mentee dashboard card and the shared announcements page', async ({ page }) => {
  const adminEmail = uniqueEmail('annfeed-admin');
  const menteeEmail = uniqueEmail('annfeed-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Feed Admin');
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Ann Feed Mentee');
  const uniqueText = `Feed announcement ${Date.now().toString(36)}`;

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    const res = await page.request.post('/api/admin/announcements', { data: { text: uniqueText } });
    expect(res.ok()).toBeTruthy();

    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');

    // Dashboard card (client-fetched — wait for it to leave the loading state).
    await expect(page.getByText(uniqueText)).toBeVisible({ timeout: 10_000 });

    // Shared history page shows the full text too.
    await page.goto('/announcements');
    await expect(page.getByTestId('announcements-full-list').getByText(uniqueText)).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.announcement.deleteMany({ where: { text: uniqueText } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('an admin announcement is also visible to mentors, via the same shared feed', async ({ page }) => {
  const adminEmail = uniqueEmail('annfeed-admin2');
  const mentorEmail = uniqueEmail('annfeed-mentor');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Feed Admin 2');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Ann Feed Mentor');
  const uniqueText = `Mentor feed announcement ${Date.now().toString(36)}`;

  try {
    await signInAsFreshUser(page, adminEmail, 'AdminPass123', '/admin');
    const res = await page.request.post('/api/admin/announcements', { data: { text: uniqueText } });
    expect(res.ok()).toBeTruthy();

    await signInAsFreshUser(page, mentorEmail, 'MentorPass123', '/mentor');

    await expect(page.getByText(uniqueText)).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.announcement.deleteMany({ where: { text: uniqueText } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('GET /api/announcements requires authentication', async ({ page }) => {
  const res = await page.request.get('/api/announcements');
  expect(res.status()).toBe(401);
});
