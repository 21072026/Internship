import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, seedCustomPipelineOrg, cleanupCustomPipelineOrg } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { dispatchScheduledAnnouncement } from '../src/lib/announcementSend';
import type { APIRequestContext } from '@playwright/test';
import { signInAsFreshUser } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #920: an untargeted admin broadcast fans out to every active user of the
// tenant (POST /api/admin/announcements; targeting is #1721, below), so a mentee
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


// #1721: targeting, scheduling and read tracking, inside a throwaway org.
test.describe('targeted and scheduled announcements', () => {
  test.describe.configure({ mode: 'serial' });
  const PW = 'Targeting123!';
  let seeded: Awaited<ReturnType<typeof seedCustomPipelineOrg>>;
  let admin: APIRequestContext;
  let mentor: APIRequestContext;
  let mentee: APIRequestContext;
  let mentorId = '';
  let menteeId = '';
  let cohortId = '';
  const ids: string[] = [];

  test.beforeAll(async ({ playwright }, info) => {
    seeded = await seedCustomPipelineOrg('anntarget', PW);
    const users = await prisma.user.findMany({ where: { orgId: seeded.org.id }, select: { id: true, role: true, email: true } });
    mentorId = users.find((u) => u.role === 'MENTOR')!.id;
    menteeId = users.find((u) => u.role === 'MENTEE')!.id;
    cohortId = (await prisma.cohort.create({ data: { orgId: seeded.org.id, name: 'Spring cohort' } })).id;
    await prisma.mentorshipRelation.update({ where: { id: seeded.relationId }, data: { cohortId } });
    const baseURL = info.project.use.baseURL;
    [admin, mentor, mentee] = await Promise.all([1, 2, 3].map(() => playwright.request.newContext({ baseURL })));
    expect((await signInViaApi(admin, seeded.adminEmail, PW)).ok).toBe(true);
    expect((await signInViaApi(mentor, users.find((u) => u.role === 'MENTOR')!.email, PW)).ok).toBe(true);
    expect((await signInViaApi(mentee, users.find((u) => u.role === 'MENTEE')!.email, PW)).ok).toBe(true);
  });

  test.afterAll(async () => {
    await Promise.all([admin, mentor, mentee].map((c) => c?.dispose()));
    if (seeded) {
      await prisma.notification.deleteMany({ where: { announcementId: { in: ids } } });
      await prisma.announcement.deleteMany({ where: { id: { in: ids } } });
      await prisma.mentorshipRelation.update({ where: { id: seeded.relationId }, data: { cohortId: null } });
      await prisma.cohort.deleteMany({ where: { id: cohortId } });
      await cleanupCustomPipelineOrg(seeded.org.id, seeded.emails);
    }
  });

  async function feedTexts(ctx: APIRequestContext): Promise<string[]> {
    const d = await (await ctx.get('/api/announcements?pageSize=50')).json();
    return d.announcements.map((a: { text: string }) => a.text);
  }

  test('"mentors in this programme" reaches exactly them; a forged recipient list is ignored', async () => {
    const text = `Targeted ${Date.now().toString(36)}`;
    const est = await (await admin.post('/api/admin/announcements/estimate', { data: { audience: { roles: ['MENTOR'], cohortIds: [cohortId] } } })).json();
    expect(est.recipients).toBe(1);

    const res = await admin.post('/api/admin/announcements', {
      data: { text, audience: { roles: ['MENTOR'], cohortIds: [cohortId] }, recipients: [menteeId], userIds: [menteeId] },
    });
    expect(res.status()).toBe(201);
    expect((await res.json()).recipients).toBe(1);
    const row = await prisma.announcement.findFirstOrThrow({ where: { text }, select: { id: true, targeted: true } });
    ids.push(row.id);
    expect(row.targeted).toBe(true);
    const delivered = await prisma.notification.findMany({ where: { announcementId: row.id }, select: { userId: true } });
    expect(delivered.map((n) => n.userId)).toEqual([mentorId]);

    expect(await feedTexts(mentor)).toContain(text);
    expect(await feedTexts(mentee)).not.toContain(text);

    // Malformed criteria are refused, never widened to everyone.
    expect((await admin.post('/api/admin/announcements', { data: { text: 'x', audience: { roles: ['SUPERUSER'] } } })).status()).toBe(400);

    // Read tracking: an aggregate over the bell rows.
    await prisma.notification.updateMany({ where: { announcementId: row.id }, data: { read: true } });
    const hist = await (await admin.get('/api/admin/announcements')).json();
    const h = hist.announcements.find((a: { id: string }) => a.id === row.id);
    expect(h).toMatchObject({ delivered: 1, read: 1, audience: { roles: ['MENTOR'], cohortIds: [cohortId] } });
  });

  test('a scheduled announcement sends once, at its time, to the audience resolved then', async () => {
    const text = `Scheduled ${Date.now().toString(36)}`;
    const when = new Date(Date.now() + 5 * 60_000);
    const res = await admin.post('/api/admin/announcements', { data: { text, audience: { roles: ['MENTEE'] }, scheduledAt: when.toISOString() } });
    expect(res.status()).toBe(201);
    expect(await res.json()).toMatchObject({ scheduled: true, estimate: { recipients: 1 } });
    const row = await prisma.announcement.findFirstOrThrow({ where: { text }, select: { id: true, status: true } });
    ids.push(row.id);
    expect(row.status).toBe('SCHEDULED');
    expect(await prisma.job.count({ where: { name: 'announcement.send', idempotencyKey: `announcement:${row.id}` } })).toBe(1);
    expect(await prisma.notification.count({ where: { announcementId: row.id } })).toBe(0);
    expect(await feedTexts(mentee)).not.toContain(text);

    // Not before its time…
    expect(await dispatchScheduledAnnouncement(row.id, new Date())).toBe('not_due_or_taken');
    // …then once.
    const at = new Date(when.getTime() + 1000);
    expect(await dispatchScheduledAnnouncement(row.id, at)).toBe('sent');
    expect(await dispatchScheduledAnnouncement(row.id, at)).toBe('not_due_or_taken');
    const delivered = await prisma.notification.findMany({ where: { announcementId: row.id }, select: { userId: true } });
    expect(delivered.map((n) => n.userId)).toEqual([menteeId]);
    const sent = await prisma.announcement.findUniqueOrThrow({ where: { id: row.id }, select: { status: true, recipientCount: true } });
    expect(sent).toEqual({ status: 'SENT', recipientCount: 1 });
    expect(await feedTexts(mentee)).toContain(text);
    expect(await feedTexts(mentor)).not.toContain(text);
  });

  test('a scheduled announcement can be cancelled before its time, and then never sends', async () => {
    const text = `Cancelled ${Date.now().toString(36)}`;
    const when = new Date(Date.now() + 5 * 60_000);
    expect((await admin.post('/api/admin/announcements', { data: { text, scheduledAt: when.toISOString() } })).status()).toBe(201);
    const row = await prisma.announcement.findFirstOrThrow({ where: { text }, select: { id: true } });
    ids.push(row.id);
    // Not an admin's action for anybody else.
    expect((await mentor.post(`/api/admin/announcements/${row.id}/cancel`)).status()).toBe(403);
    expect((await admin.post(`/api/admin/announcements/${row.id}/cancel`)).status()).toBe(200);
    expect((await admin.post(`/api/admin/announcements/${row.id}/cancel`)).status()).toBe(409);
    expect(await dispatchScheduledAnnouncement(row.id, new Date(when.getTime() + 1000))).toBe('not_due_or_taken');
    expect(await prisma.notification.count({ where: { announcementId: row.id } })).toBe(0);
    expect((await prisma.announcement.findUniqueOrThrow({ where: { id: row.id }, select: { status: true } })).status).toBe('CANCELED');
  });
});
