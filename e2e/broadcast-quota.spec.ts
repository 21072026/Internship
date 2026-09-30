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
import { gotoSettled } from './helpers/auth';
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

// #2335: a tenant whose month is spent must hold ITS OWN issues — not every
// other tenant's — and the hold must be visible rather than a log line every
// fifteen minutes.
//
// Eleven due issues from a zero-band tenant, all older than one due issue from
// a tenant with allowance left. The old tick took the ten oldest due issues and
// attempted each, so the eleven filled it and the other tenant's issue was never
// reached until the spent tenant's month rolled over. Behind them sits a
// half-delivered issue of the spent tenant (SENDING, from a run that died): a
// resume is never metered, so it must finish even while its tenant is held. The
// dates are in 2001 so these rows sort ahead of anything a parallel spec has
// queued.
test('a tenant over its band holds only its own newsletter issues, visibly (#2335)', async ({ page }) => {
  const pw = 'QuotaHoldPass123';
  const stamp = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const spent = await prisma.organization.create({ data: { slug: `bqh-spent-${stamp}`, name: 'Spent Band Org' } });
  const other = await prisma.organization.create({ data: { slug: `bqh-other-${stamp}`, name: 'Allowance Left Org' } });
  const adminEmail = uniqueEmail('bqh-admin');
  const otherAdminEmail = uniqueEmail('bqh-admin-other');
  const spentMenteeEmail = uniqueEmail('bqh-mentee-spent');
  const otherMenteeEmail = uniqueEmail('bqh-mentee-other');
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'BQH Admin');
  const otherAdmin = await seedUser(otherAdminEmail, pw, 'ADMIN', 'BQH Other Admin');
  const spentMentee = await seedUser(spentMenteeEmail, pw, 'MENTEE', 'BQH Spent Mentee');
  const otherMentee = await seedUser(otherMenteeEmail, pw, 'MENTEE', 'BQH Other Mentee');
  await prisma.user.updateMany({ where: { id: { in: [admin.id, spentMentee.id] } }, data: { orgId: spent.id } });
  await prisma.user.updateMany({ where: { id: { in: [otherAdmin.id, otherMentee.id] } }, data: { orgId: other.id } });
  await prisma.setting.create({ data: { orgId: spent.id, key: 'broadcastMonthlyRecipients', value: '0' } });

  const issue = (orgId: string, subject: string, scheduledAt: Date, status: 'SCHEDULED' | 'SENDING' = 'SCHEDULED') =>
    prisma.newsletter.create({
      data: {
        orgId,
        audience: 'MENTEE',
        status,
        subject,
        content: { en: { subject, intro: 'Hold intro.', tips: [{ emoji: '💡', title: 'Tip', body: 'One line.' }] } },
        scheduledAt,
        createdById: admin.id,
      },
      select: { id: true },
    });

  const heldIds: string[] = [];
  let otherId = '';
  let resumeId = '';
  const allIds = () => [...heldIds, otherId, resumeId].filter(Boolean);
  try {
    for (let i = 0; i < 11; i++) {
      heldIds.push((await issue(spent.id, `E2E held ${stamp} #${i + 1}`, new Date(Date.UTC(2001, 0, 1, 0, i)))).id);
    }
    resumeId = (await issue(spent.id, `E2E resume ${stamp}`, new Date(Date.UTC(2001, 0, 1, 0, 30)), 'SENDING')).id;
    otherId = (await issue(other.id, `E2E other ${stamp}`, new Date(Date.UTC(2001, 0, 2)))).id;
    // With a hero image: the dispatcher reads its bytes only once an issue is
    // claimed (a held one is refused every tick and must not pull the blob), so
    // the send that does go out is the one that proves the late read works.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await prisma.newsletterImage.create({ data: { newsletterId: otherId, contentType: 'image/png', size: png.length, data: png } });

    await signIn(page, adminEmail, pw, '/admin');

    // ── 1. The tick reaches the other tenant, and finishes the resume ───────
    const tick = await page.request.get('/api/cron?job=newsletters');
    expect(tick.ok()).toBeTruthy();
    const { newsletters } = await tick.json();

    const otherRow = await prisma.newsletter.findUnique({ where: { id: otherId } });
    expect(otherRow?.status).toBe('SENT');
    expect(await prisma.newsletterSend.count({ where: { newsletterId: otherId, userId: otherMentee.id } })).toBe(1);

    // The half-delivered issue is not left behind its tenant's held ones.
    expect((await prisma.newsletter.findUnique({ where: { id: resumeId } }))?.status).toBe('SENT');

    // The spent tenant's issues are all still waiting, untouched: nothing was
    // claimed, nothing was sent, every one of them can still be edited,
    // cancelled or sent once the band allows.
    const held = await prisma.newsletter.findMany({ where: { id: { in: heldIds } } });
    expect(held.map((h) => h.status)).toEqual(heldIds.map(() => 'SCHEDULED'));
    expect(held.every((h) => h.sentCount === 0)).toBe(true);
    expect(await prisma.newsletterSend.count({ where: { newsletterId: { in: heldIds } } })).toBe(0);

    // Each issue is metered on its own, up to the tenant's ten held attempts a
    // tick; the eleventh is left for the next tick.
    const refused = (newsletters.results as { newsletterId: string; reason?: string }[])
      .filter((r) => r.reason === 'broadcast_quota_exceeded')
      .map((r) => r.newsletterId)
      .filter((id) => heldIds.includes(id));
    expect(refused).toEqual(heldIds.slice(0, 10));
    expect(newsletters.deferred).toContain(heldIds[10]);

    // ── 2. The hold is loud once, not every tick ────────────────────────────
    const holdRows = () =>
      prisma.activityLog.findMany({
        where: { action: 'newsletter.quota_hold', targetId: { in: allIds() } },
        select: { targetId: true, detail: true },
      });
    const first = await holdRows();
    expect(first).toHaveLength(10);
    expect(new Set(first.map((r) => r.targetId))).toEqual(new Set(heldIds.slice(0, 10)));
    // The activity feed is installation-wide: the row names the tenant by id
    // only, never its name or its broadcast figures.
    const detail = JSON.parse(first[0].detail ?? '{}');
    expect(detail).toEqual({ orgId: spent.id, month: new Date().toISOString().slice(0, 7) });

    // A second tick refuses the same issues again, and reports nothing new.
    expect((await page.request.get('/api/cron?job=newsletters')).ok()).toBeTruthy();
    expect((await holdRows()).length).toBe(first.length);

    // ── 3. The admin can see why a past-due issue has not gone out ──────────
    const historyHold = async (id: string) => {
      for (let pageNo = 1; pageNo <= 5; pageNo++) {
        const history = await (await page.request.get(`/api/admin/newsletters?page=${pageNo}`)).json();
        const row = (history.newsletters as { id: string; quotaHold: Record<string, unknown> | null }[]).find(
          (r) => r.id === id,
        );
        if (row) return row.quotaHold;
      }
      return 'not found';
    };
    const hold = (await historyHold(heldIds[0])) as Record<string, unknown> | null;
    expect(hold).toMatchObject({ limit: 0, used: 0, requested: 1, remaining: 0 });
    expect(typeof hold?.resetsAt).toBe('string');

    await gotoSettled(page, '/admin/newsletters');
    await expect(page.getByTestId(`newsletter-quota-hold-${heldIds[0]}`)).toContainText('On hold');

    // ── 4. …and only to its own tenant ──────────────────────────────────────
    // The history is tenant-scoped (#2605): another tenant's admin does not
    // get the row at all, so neither the issue nor its broadcast figures
    // cross over. (This used to assert a visible row with a null hold, from
    // before the list was scoped — #2625.)
    await page.context().clearCookies();
    await signIn(page, otherAdminEmail, pw, '/admin');
    expect(await historyHold(heldIds[0])).toBe('not found');
  } finally {
    await prisma.activityLog.deleteMany({ where: { targetId: { in: allIds() } } });
    await prisma.newsletterSend.deleteMany({ where: { newsletterId: { in: allIds() } } });
    await prisma.newsletter.deleteMany({ where: { id: { in: allIds() } } });
    await prisma.setting.deleteMany({ where: { orgId: { in: [spent.id, other.id] } } });
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(otherAdminEmail);
    await cleanupByEmail(spentMenteeEmail);
    await cleanupByEmail(otherMenteeEmail);
    await prisma.organization.deleteMany({ where: { id: { in: [spent.id, other.id] } } }).catch(() => {});
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
