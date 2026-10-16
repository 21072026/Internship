import { test, expect } from '@playwright/test';
import { recipientHash } from '@/lib/mailDeliveryRule';
import { drainOnce, forgetQueuedMail } from '@/lib/mailOutbox';
import {
  mailDrainDeps,
  mailMeterIdleForTests,
  resetMailTransportsForTests,
  sendEmail,
  sendPasswordResetEmail,
} from '@/services/emailService';
import { startFakeSmtp, type FakeSmtp } from './helpers/fakeSmtp';
import { prisma } from './helpers/db';

// The mail outbox (#2944), end to end against a real database and a fake SMTP
// server this spec controls (e2e/helpers/fakeSmtp.ts).
//
// WHY IN-PROCESS. The app server Playwright boots runs with SMTP_USER blank on
// purpose (no spec may ever deliver real mail), so every mail it would send is
// SKIPPED before a transport is touched — and it starts no drain tick for the
// same reason, so it never races this spec for a row. So this spec points ITS
// OWN process at the fake server and calls the same functions the routes call
// (`sendPasswordResetEmail()` is exactly what POST /api/auth/forgot awaits
// before it answers its 200) and the same `drainOnce()` POST /api/mail/drain
// runs. The rows, the sealed envelope, the guarded settle and the EmailLog
// ledger are the real ones.
//
// Local database only: it writes the shared 'smtp' budget row and email.send
// jobs, which a deployed environment's own drain would race for.
const local = !process.env.BASE_URL;
const RUN = Date.now().toString(36);
const addr = (label: string) => `mailq-${label}-${RUN}@example.test`;

let smtp: FakeSmtp;
const saved: Record<string, string | undefined> = {};
const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_INLINE_TIMEOUT_MS', 'MAIL_METER_MODE'];

async function clearBudget() {
  await mailMeterIdleForTests();
  await prisma.mailBudget.deleteMany({ where: { name: { in: ['smtp', 'smtp:bulk'] } } });
}

async function jobsFor(address: string) {
  const rcpt = recipientHash(address);
  const rows = await prisma.job.findMany({ where: { name: 'email.send' }, orderBy: { createdAt: 'asc' } });
  return rows.filter((r) => (r.payload as { rcpt?: string } | null)?.rcpt === rcpt);
}

async function logFor(address: string) {
  return prisma.emailLog.findMany({ where: { to: address }, orderBy: { createdAt: 'asc' } });
}

/** Make every queued row for this address due now (the test's stand-in for waiting). */
async function dueNow(address: string) {
  const ids = (await jobsFor(address)).filter((j) => j.status === 'PENDING').map((j) => j.id);
  await prisma.job.updateMany({ where: { id: { in: ids } }, data: { runAt: new Date(Date.now() - 1000) } });
}

test.describe('mail queue', () => {
  test.skip(!local, 'drives the queue against the local database and a local fake SMTP server');

  test.beforeAll(async () => {
    smtp = await startFakeSmtp();
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_USER = 'mailq-e2e';
    process.env.SMTP_PASS = 'mailq-e2e';
    process.env.SMTP_FROM = 'noreply@example.test';
    process.env.NEXTAUTH_SECRET ||= 'e2e-mail-queue-secret';
    delete process.env.MAIL_METER_MODE;
    delete process.env.MAIL_INLINE_TIMEOUT_MS;
    resetMailTransportsForTests();
    await clearBudget();
  });

  test.afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetMailTransportsForTests();
    await clearBudget().catch(() => {});
    await prisma.job.deleteMany({ where: { name: 'email.send', idempotencyKey: { startsWith: 'mail:' } } }).catch(() => {});
    await smtp?.close();
  });

  test.beforeEach(async () => {
    smtp.mode = { kind: 'accept' };
    await clearBudget();
  });

  test(
    'a password reset during a relay throttle answers in under a second and is delivered after the retry',
    { tag: '@smoke' },
    async () => {
      const to = addr('reset');
      smtp.mode = { kind: 'refuse', stage: 'MAIL', reply: '450 4.7.1 Error: too much mail from 127.0.0.1' };

      const started = Date.now();
      const result = await sendPasswordResetEmail({ to, token: `tok${RUN}`, fullName: 'Queue Test' });
      const elapsed = Date.now() - started;

      // Not lost, not thrown, and the person waiting is not kept waiting.
      expect(result).toBe('QUEUED');
      expect(elapsed).toBeLessThan(1000);
      expect((await logFor(to)).map((l) => l.status)).toEqual(['DEFERRED']);

      const [job] = await jobsFor(to);
      expect(job.status).toBe('PENDING');
      expect(job.priority).toBe(100);
      expect(job.attempts).toBe(0);
      const payload = job.payload as Record<string, unknown>;
      expect(payload.lane).toBe('CRITICAL');
      expect(payload.reason).toBe('retry');
      // Sealed: neither the address nor the reset link is readable on the row.
      expect(JSON.stringify(job.payload)).not.toContain(to);
      expect(JSON.stringify(job.payload)).not.toContain(`tok${RUN}`);
      // The link's own lifetime bounds the mail's: at most an hour.
      expect(Date.parse(String(payload.notAfter)) - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
      // A relay throttle waits out the pause before the first retry.
      expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);

      // The relay recovers; the pause runs out.
      smtp.mode = { kind: 'accept' };
      await clearBudget();
      await dueNow(to);
      const summary = await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
      expect(summary.sent).toBeGreaterThanOrEqual(1);

      const delivered = smtp.to(to);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].data).toContain(`tok${RUN}`);
      const settled = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      expect(settled.status).toBe('SUCCEEDED');
      expect((settled.payload as Record<string, unknown>).box).toBeNull();
      expect((await logFor(to)).map((l) => l.status)).toEqual(['DEFERRED', 'SENT']);
    }
  );

  test('a 5xx is final: recorded FAILED, thrown, never queued', async () => {
    const to = addr('reject');
    smtp.mode = { kind: 'refuse', stage: 'RCPT', reply: '550 5.1.1 User unknown' };
    await expect(sendEmail({ to, subject: 'x', html: '<p>x</p>', category: 'message' })).rejects.toThrow();
    expect((await logFor(to)).map((l) => l.status)).toEqual(['FAILED']);
    expect(await jobsFor(to)).toHaveLength(0);
  });

  test('a 4xx about the message is retried with backoff and costs an attempt', async () => {
    const to = addr('busy');
    smtp.mode = { kind: 'refuse', stage: 'RCPT', reply: '452 4.2.2 Mailbox full' };
    expect(await sendEmail({ to, subject: 'busy', html: '<p>busy</p>', category: 'message' })).toBe('QUEUED');
    const [job] = await jobsFor(to);
    expect(job.priority).toBe(50); // TRANSACTIONAL

    // Still full on the first queued try: retried, charged, later.
    await dueNow(to);
    await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
    const retried = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(retried.status).toBe('PENDING');
    expect(retried.attempts).toBe(1);
    expect(retried.lastError).toMatch(/smtp_452/);
    expect(retried.runAt.getTime()).toBeGreaterThan(Date.now());

    smtp.mode = { kind: 'accept' };
    await dueNow(to);
    await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(smtp.to(to)).toHaveLength(1);
    expect((await logFor(to)).map((l) => l.status)).toEqual(['DEFERRED', 'DEFERRED', 'SENT']);
  });

  test('a relay throttle seen by the drain releases the batch without charging it', async () => {
    const to = addr('relay');
    smtp.mode = { kind: 'refuse', stage: 'RCPT', reply: '452 4.2.2 Mailbox full' };
    expect(await sendEmail({ to, subject: 'relay', html: '<p>relay</p>', category: 'message' })).toBe('QUEUED');
    const [job] = await jobsFor(to);

    smtp.mode = { kind: 'refuse', stage: 'MAIL', reply: '421 4.7.0 Try again later' };
    await dueNow(to);
    const summary = await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
    expect(summary.stoppedBy).toBe('relay');
    const released = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(released.status).toBe('PENDING');
    expect(released.attempts).toBe(0);
    expect((released.payload as Record<string, unknown>).releases).toBe(1);
    expect(released.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // …and the budget is paused for everybody.
    const budget = await prisma.mailBudget.findUnique({ where: { name: 'smtp' } });
    expect(budget?.pauseLevel).toBeGreaterThan(0);
  });

  test('an open breaker queues critical mail without an SMTP attempt', async () => {
    const to = addr('breaker');
    await prisma.mailBudget.create({
      data: {
        name: 'smtp',
        tat: new Date(Date.now() + 10 * 60_000),
        pausedUntil: new Date(Date.now() + 10 * 60_000),
        pauseLevel: 2,
        dayCount: 0,
      },
    });
    const before = smtp.connections;
    expect(await sendEmail({ to, subject: 'breaker', html: '<p>b</p>', category: 'verification' })).toBe('QUEUED');
    expect(smtp.connections).toBe(before);
    const [job] = await jobsFor(to);
    expect(job.priority).toBe(100);
    expect((job.payload as Record<string, unknown>).reason).toBe('breaker');
    // The drain holds back too, until the pause runs out.
    await dueNow(to);
    expect((await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() })).stoppedBy).toBe('breaker');
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PENDING');
  });

  test('observe mode: a meter hours ahead does not hold critical mail once the pause is over', async () => {
    // After a large burst the observe-mode meter sits far ahead, and an earlier
    // throttle left the rung raised — but the pause itself has run out. The
    // critical mail is tried inline (and is the probe that walks the ladder down).
    const to = addr('probe');
    await prisma.mailBudget.create({
      data: {
        name: 'smtp',
        tat: new Date(Date.now() + 150 * 60_000),
        pausedUntil: new Date(Date.now() - 5_000),
        pauseLevel: 1,
        dayCount: 0,
      },
    });
    const before = smtp.connections;
    expect(await sendEmail({ to, subject: 'probe', html: '<p>p</p>', category: 'verification' })).toBe('SENT');
    expect(smtp.connections).toBeGreaterThan(before);
    expect(await jobsFor(to)).toHaveLength(0);
    await expect
      .poll(async () => (await prisma.mailBudget.findUnique({ where: { name: 'smtp' } }))?.pauseLevel, { timeout: 5_000 })
      .toBe(0);
  });

  test('a critical send past its inline cap is queued and the request answered', async () => {
    const to = addr('slow');
    smtp.mode = { kind: 'hang' };
    process.env.MAIL_INLINE_TIMEOUT_MS = '1000';
    try {
      const started = Date.now();
      expect(await sendEmail({ to, subject: 'slow', html: '<p>slow</p>', category: 'verification' })).toBe('QUEUED');
      expect(Date.now() - started).toBeLessThan(2_500);
    } finally {
      delete process.env.MAIL_INLINE_TIMEOUT_MS;
    }
    const [job] = await jobsFor(to);
    expect((job.payload as Record<string, unknown>).reason).toBe('inline_timeout');
    // The copy waits for the in-flight send to finish before the drain may take it.
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect((await logFor(to)).map((l) => l.status)).toEqual(['DEFERRED']);

    // The in-flight send gives up at the urgent transport's greeting timeout
    // (3 s). A temporary failure: the queued copy stays as the retry.
    await new Promise((r) => setTimeout(r, 3_500));
    await mailMeterIdleForTests();
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PENDING');
    await prisma.job.delete({ where: { id: job.id } });
  });

  test('an expired queued mail is cancelled, its envelope cleared', async () => {
    const to = addr('expired');
    smtp.mode = { kind: 'refuse', stage: 'RCPT', reply: '452 4.2.2 Mailbox full' };
    expect(await sendEmail({ to, subject: 'old', html: '<p>old</p>', category: 'message' })).toBe('QUEUED');
    const [job] = await jobsFor(to);
    await prisma.job.update({
      where: { id: job.id },
      data: { payload: { ...(job.payload as object), notAfter: new Date(Date.now() - 1000).toISOString() } },
    });
    smtp.mode = { kind: 'accept' };
    await dueNow(to);
    await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
    const row = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('CANCELLED');
    expect(row.lastError).toBe('expired');
    expect((row.payload as Record<string, unknown>).box).toBeNull();
    expect(smtp.to(to)).toHaveLength(0);
  });

  test('account erasure deletes queued mail by recipient hash', async () => {
    const to = addr('erase');
    smtp.mode = { kind: 'refuse', stage: 'RCPT', reply: '452 4.2.2 Mailbox full' };
    expect(await sendEmail({ to, subject: 'erase', html: '<p>e</p>', category: 'message' })).toBe('QUEUED');
    expect(await jobsFor(to)).toHaveLength(1);
    expect(await forgetQueuedMail(to.toUpperCase())).toBe(1);
    expect(await jobsFor(to)).toHaveLength(0);
  });
});

test('the drain endpoint answers only to its secret', async ({ request }) => {
  const res = await request.post('/api/mail/drain', { headers: { 'x-cron-secret': 'not-the-secret' } });
  // 401 with a secret configured (CRON_SECRET, or the one the server minted for
  // itself); 503 only on a server with neither — never a drain.
  expect([401, 503]).toContain(res.status());
});
