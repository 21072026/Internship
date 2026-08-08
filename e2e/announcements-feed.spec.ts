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

// #1161: an announcement is a message to the people who were there, so a user
// who joined afterwards must not see it — not on the dashboard card and not in
// the /announcements archive. Both surfaces read GET /api/announcements, which
// cuts the feed at the reader's own createdAt.
test('a user does not see announcements broadcast before they joined', async ({ page }) => {
  const adminEmail = uniqueEmail('annjoin-admin');
  const menteeEmail = uniqueEmail('annjoin-mentee');
  const stamp = Date.now().toString(36);
  const beforeText = `Before-join announcement ${stamp}`;
  const afterText = `After-join announcement ${stamp}`;
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Ann Join Admin');

  // Broadcast a day before the mentee's account exists.
  await prisma.announcement.create({
    data: {
      text: beforeText,
      sentById: admin.id,
      recipientCount: 1,
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  });

  // The mentee joins now…
  await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'Ann Join Mentee');
  // …and only then is the second announcement broadcast.
  await prisma.announcement.create({ data: { text: afterText, sentById: admin.id, recipientCount: 2 } });

  try {
    await signInAsFreshUser(page, menteeEmail, 'MenteePass123', '/portal');

    // Dashboard card: the post-join one only.
    const card = page.getByTestId('announcements-list');
    await expect(card.getByText(afterText)).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(beforeText)).toHaveCount(0);

    // The archive is cut at the same line — it is not a back door to the history.
    await page.goto('/announcements');
    const list = page.getByTestId('announcements-full-list');
    await expect(list.getByText(afterText)).toBeVisible({ timeout: 10_000 });
    await expect(list.getByText(beforeText)).toHaveCount(0);

    // The API's own count agrees, so pagination cannot page back into the past.
    const feed = await (await page.request.get('/api/announcements?page=1&pageSize=50')).json();
    expect(feed.announcements.some((a: { text: string }) => a.text === beforeText)).toBe(false);
  } finally {
    await prisma.announcement.deleteMany({ where: { text: { in: [beforeText, afterText] } } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('GET /api/announcements requires authentication', async ({ page }) => {
  const res = await page.request.get('/api/announcements');
  expect(res.status()).toBe(401);
});
