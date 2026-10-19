import { test, expect } from '@playwright/test';
import { dedupeKeyFor, recipientHash } from '@/lib/mailDeliveryRule';
import { drainOnce, resetDrainStateForTests } from '@/lib/mailOutbox';
import { mailAnnouncement, type AnnouncementMailRecipient } from '@/lib/announcementMail';
import {
  mailDrainDeps,
  mailMeterIdleForTests,
  resetMailTransportsForTests,
  sendEmail,
  sendPasswordResetEmail,
  sendUnreadMessageDigests,
} from '@/services/emailService';
import { startFakeSmtp, type FakeSmtp } from './helpers/fakeSmtp';
import { cleanupMenteeWithRelation, prisma, seedMenteeWithRelation, type SeededRelation } from './helpers/db';

// Pacing transactional and bulk mail through the queue (#2951), end to end
// against a real database and the fake SMTP server (e2e/helpers/fakeSmtp.ts).
//
// In-process, for the reason e2e/mail-queue.spec.ts gives: the app server
// Playwright boots sends no mail at all (SMTP_USER is blank there), so this
// spec points ITS OWN process at the fake relay, sets the per-environment mail
// settings a deployment would, and calls the same functions the routes and the
// drain call — `mailAnnouncement()` is the announcement route's fan-out,
// `drainOnce()` is one tick of POST /api/mail/drain.
//
// Local database only: it writes the shared 'smtp' budget row and email.send
// jobs, which a deployed environment's own drain would race for.
const local = !process.env.BASE_URL;
const RUN = Date.now().toString(36);
const addr = (label: string) => `mailp-${label}-${RUN}@example.test`;

// The test rate: 300/min is one token every 200 ms, a burst of 3 and no
// reserve — fast enough to drain thirty mails in seconds, slow enough that the
// pacing is measurable.
const RATE_PER_MIN = 300;
const BURST = 3;
const INTERVAL_MS = 60_000 / RATE_PER_MIN;

const ENV = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'MAIL_QUEUE_LANES',
  'MAIL_METER_MODE',
  'MAIL_RATE_PER_MIN',
  'MAIL_BURST',
  'MAIL_URGENT_RESERVE',
  'MAIL_DAILY_CAP',
  'MAIL_INLINE_TIMEOUT_MS',
];
const saved: Record<string, string | undefined> = {};
let smtp: FakeSmtp;

async function clearBudget() {
  await mailMeterIdleForTests();
  await prisma.mailBudget.deleteMany({ where: { name: { in: ['smtp', 'smtp:bulk'] } } });
}

async function jobsFor(addresses: string[]) {
  const wanted = new Set(addresses.map((a) => recipientHash(a)));
  const rows = await prisma.job.findMany({ where: { name: 'email.send' }, orderBy: { createdAt: 'asc' } });
  return rows.filter((r) => wanted.has(String((r.payload as { rcpt?: string } | null)?.rcpt)));
}

async function forget(addresses: string[]) {
  const ids = (await jobsFor(addresses)).map((j) => j.id);
  if (ids.length) await prisma.job.deleteMany({ where: { id: { in: ids } } });
  await prisma.emailLog.deleteMany({ where: { to: { in: addresses } } });
}

test.describe('mail pacing', () => {
  test.skip(!local, 'drives the queue against the local database and a local fake SMTP server');
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    smtp = await startFakeSmtp();
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = 'mailp-e2e';
    process.env.SMTP_PASS = 'mailp-e2e';
    process.env.SMTP_FROM = 'noreply@example.test';
    process.env.NEXTAUTH_SECRET ||= 'e2e-mail-pacing-secret';
    // A deployment's recommended settings, at a test rate.
    process.env.MAIL_QUEUE_LANES = 'TRANSACTIONAL,BULK';
    process.env.MAIL_METER_MODE = 'enforce';
    process.env.MAIL_RATE_PER_MIN = String(RATE_PER_MIN);
    process.env.MAIL_BURST = String(BURST);
    process.env.MAIL_URGENT_RESERVE = '0';
    delete process.env.MAIL_DAILY_CAP;
    delete process.env.MAIL_INLINE_TIMEOUT_MS;
    resetMailTransportsForTests();
    resetDrainStateForTests();
    await clearBudget();
  });

  test.afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetMailTransportsForTests();
    resetDrainStateForTests();
    await clearBudget().catch(() => {});
    await smtp?.close();
  });

  test.beforeEach(async () => {
    smtp.mode = { kind: 'accept' };
    resetDrainStateForTests();
    await clearBudget();
  });

  const recipients = (label: string, n: number): AnnouncementMailRecipient[] =>
    Array.from({ length: n }, (_, i) => ({
      // No User row behind them: the drain's preference re-check fails open for
      // an unknown account, exactly like the inline gate.
      id: `mailp${RUN}${label}${i}`,
      email: addr(`${label}${i}`),
      orgId: null,
      emailNotifications: true,
      notificationPrefs: null,
      preferredLanguage: 'en',
    }));

  test(
    'a password reset still goes inline, at once, behind a full bulk backlog',
    { tag: '@smoke' },
    async () => {
      const bulk = recipients('backlog', 30);
      const to = addr('reset');
      try {
        const queued = await mailAnnouncement({ recipients: bulk, text: `Backlog ${RUN}`, translations: {} });
        expect(queued.queued).toBe(30);
        // The meter is spent far ahead: the bulk lane could not send a thing.
        await prisma.mailBudget.upsert({
          where: { name: 'smtp' },
          create: { name: 'smtp', tat: new Date(Date.now() + 30 * 60_000), pauseLevel: 0, dayCount: 0 },
          update: { tat: new Date(Date.now() + 30 * 60_000) },
        });

        const started = Date.now();
        const result = await sendPasswordResetEmail({ to, token: `tok${RUN}`, fullName: 'Pacing Test' });
        expect(result).toBe('SENT');
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(smtp.to(to)).toHaveLength(1);
        // …and not one bulk mail jumped the meter to get there.
        expect(bulk.flatMap((r) => smtp.to(r.email))).toHaveLength(0);
        const waiting = await jobsFor(bulk.map((r) => r.email));
        expect(waiting.filter((j) => j.status === 'PENDING')).toHaveLength(30);
        expect(await jobsFor([to])).toHaveLength(0);
      } finally {
        await forget([...bulk.map((r) => r.email), to]);
      }
    }
  );

  test('a 30-recipient announcement is queued whole, then delivered at the configured pace', async () => {
    test.setTimeout(90_000);
    const bulk = recipients('ann', 30);
    const emails = bulk.map((r) => r.email);
    try {
      const started = Date.now();
      const result = await mailAnnouncement({ recipients: bulk, text: `Hello ${RUN}`, translations: {} });
      // Queued, not sent: the request answers without a single SMTP conversation.
      expect(result).toEqual({ emailed: 30, held: 0, queued: 30, failed: 0 });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(emails.flatMap((e) => smtp.to(e))).toHaveLength(0);
      const jobs = await jobsFor(emails);
      expect(jobs).toHaveLength(30);
      for (const j of jobs) {
        const p = j.payload as Record<string, unknown>;
        expect(p.lane).toBe('BULK');
        expect(p.reason).toBe('lane');
        expect(p.world).toBe('INTERNSHIP');
        expect(j.priority).toBeLessThanOrEqual(20);
      }

      // The drain, tick after tick, until everything has left.
      const deadline = Date.now() + 75_000;
      while (Date.now() < deadline && emails.flatMap((e) => smtp.to(e)).length < 30) {
        await drainOnce({ maxMs: 3_000, deps: mailDrainDeps() });
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(emails.flatMap((e) => smtp.to(e))).toHaveLength(30);
      const settled = await jobsFor(emails);
      expect(settled.map((j) => j.status)).toEqual(Array(30).fill('SUCCEEDED'));

      // Paced: the ledger's SENT times spread over at least (30 − burst)
      // intervals, and no one-second window carries more than the budget allows.
      const sentAt = (await prisma.emailLog.findMany({ where: { to: { in: emails }, status: 'SENT' }, select: { createdAt: true } }))
        .map((r) => r.createdAt.getTime())
        .sort((a, b) => a - b);
      expect(sentAt).toHaveLength(30);
      expect(sentAt[29] - sentAt[0]).toBeGreaterThanOrEqual((30 - BURST - 1) * INTERVAL_MS * 0.9);
      const perSecond = Math.ceil(1000 / INTERVAL_MS) + BURST;
      for (let i = 0; i < sentAt.length; i++) {
        const inWindow = sentAt.filter((t) => t >= sentAt[i] && t < sentAt[i] + 1000).length;
        expect(inWindow).toBeLessThanOrEqual(perSecond);
      }
    } finally {
      await forget(emails);
    }
  });

  test('a meeting reminder still queued when the meeting starts is cancelled, never sent late', async () => {
    const to = addr('reminder');
    const startsAt = new Date(Date.now() + 1_500);
    const key = dedupeKeyFor({ kind: 'meeting-reminder', meetingId: `mtg${RUN}`, userId: `usr${RUN}`, at: startsAt });
    try {
      const send = () =>
        sendEmail({
          to,
          subject: 'Starting soon',
          html: '<p>Your meeting starts soon.</p>',
          category: 'meeting-reminder',
          // no-user-row: a synthetic recipient; this case is about the queue's clock.
          dedupeKey: key,
          notAfter: startsAt,
        });
      expect(await send()).toBe('QUEUED');
      // A tick that fires twice queues the reminder once.
      expect(await send()).toBe('QUEUED');
      const [job, ...extra] = await jobsFor([to]);
      expect(extra).toHaveLength(0);
      expect(job.idempotencyKey).toBe(key);
      expect(job.priority).toBe(50);
      expect(Date.parse(String((job.payload as Record<string, unknown>).notAfter))).toBe(startsAt.getTime());

      // The drain only gets to it after the start.
      await new Promise((r) => setTimeout(r, 2_000));
      await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
      const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.status).toBe('CANCELLED');
      expect(row.lastError).toBe('expired');
      expect((row.payload as Record<string, unknown>).box).toBeNull();
      expect(smtp.to(to)).toHaveLength(0);
    } finally {
      await forget([to]);
    }
  });

  test('the unread digest stamps only the lines whose digest left', async () => {
    let open: SeededRelation | null = null;
    let muted: SeededRelation | null = null;
    const since = new Date();
    try {
      open = await seedMenteeWithRelation(`mailp-open-${RUN}`, 'MailPacing123!');
      muted = await seedMenteeWithRelation(`mailp-off-${RUN}`, 'MailPacing123!');
      // This mentee switched every e-mail off: the digest is skipped for them.
      await prisma.user.update({ where: { id: muted.menteeId }, data: { emailNotifications: false } });
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const delivered = await prisma.message.create({
        data: { relationId: open.relationId, senderId: open.mentorId, body: 'Old open line', createdAt: old },
      });
      const skipped = await prisma.message.create({
        data: { relationId: muted.relationId, senderId: muted.mentorId, body: 'Old line nobody will mail', createdAt: old },
      });

      await sendUnreadMessageDigests();

      const digestedAt = async (id: string) => (await prisma.message.findUniqueOrThrow({ where: { id }, select: { digestedAt: true } })).digestedAt;
      // QUEUED (BULK is queued outright here): on its way, so its line is digested.
      const [job] = await jobsFor([open.menteeEmail]);
      expect(job).toBeTruthy();
      expect((job.payload as Record<string, unknown>).category).toBe('unread-digest');
      expect(await digestedAt(delivered.id)).not.toBeNull();
      // Skipped: the line is NOT stamped — it waits for a digest that leaves.
      expect(await digestedAt(skipped.id)).toBeNull();
      expect(await jobsFor([muted.menteeEmail])).toHaveLength(0);
    } finally {
      for (const s of [open, muted]) {
        if (!s) continue;
        await forget(s.emails);
        await cleanupMenteeWithRelation(s);
      }
      // The digest run is global: it may have queued digests for other specs'
      // old unread lines too. Those rows are this run's, not theirs to keep.
      const stray = (await prisma.job.findMany({ where: { name: 'email.send', createdAt: { gte: since } } })).filter(
        (j) => (j.payload as { category?: string } | null)?.category === 'unread-digest',
      );
      if (stray.length) await prisma.job.deleteMany({ where: { id: { in: stray.map((j) => j.id) } } });
    }
  });

  test('an unread digest the mailbox refuses for good is settled, not retried every hour', async () => {
    let gone: SeededRelation | null = null;
    const since = new Date();
    const lanes = process.env.MAIL_QUEUE_LANES;
    try {
      gone = await seedMenteeWithRelation(`mailp-gone-${RUN}`, 'MailPacing123!');
      const line = await prisma.message.create({
        data: { relationId: gone.relationId, senderId: gone.mentorId, body: 'Old line to a dead mailbox', createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
      });
      // Inline (the default lanes): the relay answers a permanent 5xx, so the
      // send throws instead of queueing.
      process.env.MAIL_QUEUE_LANES = '';
      smtp.mode = { kind: 'refuse', stage: 'RCPT', reply: '550 5.1.1 No such mailbox' };

      await sendUnreadMessageDigests();

      const after = await prisma.message.findUniqueOrThrow({ where: { id: line.id }, select: { digestedAt: true } });
      // Stamped: the next hourly run must not build a fresh digest for the same
      // dead mailbox under a new hour key.
      expect(after.digestedAt).not.toBeNull();
      expect(await jobsFor([gone.menteeEmail])).toHaveLength(0);
    } finally {
      process.env.MAIL_QUEUE_LANES = lanes;
      smtp.mode = { kind: 'accept' };
      if (gone) {
        await forget(gone.emails);
        await cleanupMenteeWithRelation(gone);
      }
      const stray = (await prisma.job.findMany({ where: { name: 'email.send', createdAt: { gte: since } } })).filter(
        (j) => (j.payload as { category?: string } | null)?.category === 'unread-digest',
      );
      if (stray.length) await prisma.job.deleteMany({ where: { id: { in: stray.map((j) => j.id) } } });
    }
  });
});
