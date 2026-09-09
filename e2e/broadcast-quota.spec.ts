// Per-org broadcast sending quota (#1754).
//
// Two things are worth asserting and they pull in opposite directions:
//   1. a broadcast over the month's band is refused WHOLE — 403, with the
//      figures, and nothing written or sent;
//   2. with the band at ZERO, every free-core mail path still works. That half
//      is the promise the whole feature is constrained by, so it is asserted
//      rather than trusted.
//
// The band is driven per tenant from a `Setting` row on the test org, never
// globally: the global layer is shared with every spec running in parallel, and
// switching broadcasts off for the whole installation mid-suite would be a
// perfectly reproducible way to break somebody else's test.
import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import {
  BROADCAST_EMAIL_CATEGORIES,
  broadcastMonth,
  isBroadcastEmailCategory,
} from '@/lib/broadcastQuota';

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

test('a broadcast over the month band is refused whole and sends nothing', async ({ page }) => {
  const pw = 'QuotaPass123';
  const org = await prisma.organization.create({
    data: { slug: `bq-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, name: 'Broadcast Quota Org' },
  });
  const adminEmail = uniqueEmail('bq-admin');
  const menteeEmail = uniqueEmail('bq-mentee');
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'BQ Admin');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'BQ Mentee');
  await prisma.user.updateMany({ where: { id: { in: [admin.id, mentee.id] } }, data: { orgId: org.id } });
  // The band, for this tenant only. 0 = no broadcast recipients at all.
  await prisma.setting.create({ data: { orgId: org.id, key: 'broadcastMonthlyRecipients', value: '0' } });

  const text = `E2E quota announcement ${Date.now().toString(36)}`;
  const inAppText = `E2E quota in-app ${Date.now().toString(36)}`;
  const newsletterSubject = `E2E quota issue ${Date.now().toString(36)}`;

  try {
    await signIn(page, adminEmail, pw, '/admin');

    // The composer's meter reports the band it is about to refuse against.
    const status = await (await page.request.get('/api/admin/broadcast-quota')).json();
    expect(status.limit).toBe(0);
    expect(status.used).toBe(0);
    expect(typeof status.resetsAt).toBe('string');

    // ── 1. The e-mail broadcast is refused whole ────────────────────────────
    const refused = await page.request.post('/api/admin/announcements', {
      data: { text, email: true },
    });
    expect(refused.status()).toBe(403);
    const body = await refused.json();
    expect(body.code).toBe('broadcast_quota_exceeded');
    expect(body.limit).toBe(0);
    expect(body.used).toBe(0);
    expect(body.requested).toBeGreaterThan(0);
    expect(typeof body.resetsAt).toBe('string');

    // Nothing was written: no Announcement row, so no notification either. A
    // refusal that still filled everyone's bell would be the half-delivered
    // blast this feature exists to prevent.
    expect(await prisma.announcement.findFirst({ where: { text } })).toBeNull();

    // ── 2. Free core, with the band at zero ─────────────────────────────────
    // An in-app-only announcement is NOT a broadcast e-mail and is never
    // metered, so it still goes out untouched.
    const inApp = await page.request.post('/api/admin/announcements', {
      data: { text: inAppText, email: false },
    });
    expect(inApp.status()).toBe(201);
    const inAppRow = await prisma.announcement.findFirst({ where: { text: inAppText } });
    expect(inAppRow).not.toBeNull();
    expect(inAppRow?.emailedCount).toBe(0);

    // ── 3. A refused "send now" is DISARMED, not left queued ────────────────
    // `scheduledAt` for a send-now is `new Date()`, so an issue left SCHEDULED
    // after the 403 is due: the cron would mail, unattended, the very issue the
    // admin was told had not been sent. The row must come back as a DRAFT.
    const refusedIssue = await page.request.post('/api/admin/newsletters', {
      data: {
        audience: 'MENTEE',
        action: 'send',
        content: {
          en: {
            subject: newsletterSubject,
            intro: 'Quota intro sentence.',
            tips: [{ emoji: '💡', title: 'Only tip', body: 'One line.' }],
          },
        },
      },
    });
    expect(refusedIssue.status()).toBe(403);
    const issueBody = await refusedIssue.json();
    expect(issueBody.code).toBe('broadcast_quota_exceeded');
    expect(issueBody.status).toBe('DRAFT');
    const issueRow = await prisma.newsletter.findFirst({ where: { subject: newsletterSubject } });
    expect(issueRow?.status).toBe('DRAFT');
    expect(issueRow?.scheduledAt).toBeNull();
    expect(issueRow?.sentCount).toBe(0);
    expect(await prisma.newsletterSend.count({ where: { newsletterId: issueRow!.id } })).toBe(0);
  } finally {
    await prisma.newsletterSend.deleteMany({ where: { newsletter: { subject: newsletterSubject } } });
    await prisma.newsletter.deleteMany({ where: { subject: newsletterSubject } });
    await prisma.announcement.deleteMany({ where: { text: { in: [text, inAppText] } } });
    await prisma.setting.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(menteeEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

test('free-core mail keeps working for a tenant whose broadcast band is zero', async ({ browser }) => {
  const pw = 'QuotaFreePass123';
  const org = await prisma.organization.create({
    data: { slug: `bqf-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, name: 'Broadcast Quota Free Org' },
  });
  const mentorEmail = uniqueEmail('bqf-mentor');
  const menteeEmail = uniqueEmail('bqf-mentee');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'BQF Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'BQF Mentee');
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId: org.id } });
  await prisma.setting.create({ data: { orgId: org.id, key: 'broadcastMonthlyRecipients', value: '0' } });
  const rel = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id, status: 'ACTIVE' },
  });

  const mentorCtx = await browser.newContext();
  const menteeCtx = await browser.newContext();
  try {
    const mentorPage = await mentorCtx.newPage();
    await signIn(mentorPage, mentorEmail, pw, '/mentor');

    // A 1:1 message — the mail it triggers is a notification, not a broadcast.
    const message = await mentorPage.request.post('/api/messages', {
      data: { relationId: rel.id, body: 'Still free, still sending.' },
    });
    expect(message.ok()).toBeTruthy();

    // A meeting invitation, which mails the mentee and later mails a reminder.
    const meeting = await mentorPage.request.post('/api/meetings', {
      data: {
        relationIds: [rel.id],
        title: 'Free-core sync',
        scheduledAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    expect(meeting.ok()).toBeTruthy();

    // The mentee's own side of the free core.
    const menteePage = await menteeCtx.newPage();
    await signIn(menteePage, menteeEmail, pw, '/portal');
    const question = await menteePage.request.post('/api/questions', {
      data: { relationId: rel.id, question: 'Does the quota touch this?' },
    });
    expect(question.ok()).toBeTruthy();
  } finally {
    await mentorCtx.close();
    await menteeCtx.close();
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await prisma.setting.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});

// Pure assertions on the metered set — no browser, no database. This is the
// list the issue asks to be enumerated in ONE constant, and the point of the
// constant is that nothing else can quietly join it.
test('only the two broadcast categories are metered', async () => {
  expect([...BROADCAST_EMAIL_CATEGORIES].sort()).toEqual(['announcement', 'newsletter']);

  for (const free of [
    'message',
    'invitation',
    'password-reset',
    'account',
    'meeting-invite',
    'meeting-reminder',
    'meeting-series-reminder',
    'interaction-reminder',
    'activity-digest',
    'mentor-digest',
    'dormant-check-in',
    'stage-deadline',
    're-engagement',
    'necessary',
  ]) {
    expect(isBroadcastEmailCategory(free)).toBe(false);
  }
  expect(isBroadcastEmailCategory(null)).toBe(false);
  expect(isBroadcastEmailCategory('announcement')).toBe(true);
  expect(isBroadcastEmailCategory('newsletter')).toBe(true);
});

test('the meter window is the calendar month in UTC', async () => {
  const { start, resetsAt } = broadcastMonth(new Date('2026-03-17T22:30:00.000Z'));
  expect(start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  expect(resetsAt.toISOString()).toBe('2026-04-01T00:00:00.000Z');

  // December has to roll the year, which is the arithmetic a hand-written
  // month window gets wrong.
  const december = broadcastMonth(new Date('2026-12-31T23:59:59.000Z'));
  expect(december.resetsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
});
