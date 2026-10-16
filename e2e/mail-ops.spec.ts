import { test, expect } from '@playwright/test';
import { recipientHash } from '@/lib/mailDeliveryRule';
import { drainOnce, resetDrainStateForTests } from '@/lib/mailOutbox';
import { evaluateMailOps, resetMailOpsAlertsForTests } from '@/lib/mailOpsAlert';
import { noteRelayAuthRejected, takeRelayAuthRejected } from '@/lib/mailOpsSignal';
import { mailDrainDeps, mailMeterIdleForTests, resetMailTransportsForTests, sendEmail } from '@/services/emailService';
import { startFakeSmtp, type FakeSmtp } from './helpers/fakeSmtp';
import { prisma } from './helpers/db';

// The mail sink and the operator alerts (#2953), in this spec's own process —
// the same reason as e2e/mail-queue.spec.ts: the app server Playwright boots
// sends no mail, so the spec points ITS process at two fake SMTP servers (the
// "relay" and the "sink") and calls the functions the routes call.
//
// Local database only: it writes the shared 'smtp' budget row, email.send jobs
// and hourly ops alert keys, which a deployed environment's drain would race.
const local = !process.env.BASE_URL;
const RUN = Date.now().toString(36);
const stranger = (label: string) => `mops-${label}-${RUN}@stranger.example.test`;
const allowed = (label: string) => `mops-${label}-${RUN}@allowed.example.test`;

let relay: FakeSmtp;
let sink: FakeSmtp;
const saved: Record<string, string | undefined> = {};
const ENV = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'MAIL_SINK_HOST',
  'MAIL_SINK_PORT',
  'MAIL_RECIPIENT_ALLOWLIST',
  'MAIL_METER_MODE',
  'MAIL_INLINE_TIMEOUT_MS',
  'MAIL_QUEUE_LANES',
  'ALERT_EMAIL_TO',
];

async function clearBudget() {
  await mailMeterIdleForTests();
  await prisma.mailBudget.deleteMany({ where: { name: { in: ['smtp', 'smtp:bulk'] } } });
}

async function jobsFor(address: string) {
  const rcpt = recipientHash(address);
  const rows = await prisma.job.findMany({ where: { name: 'email.send' }, orderBy: { createdAt: 'asc' } });
  return rows.filter((r) => (r.payload as { rcpt?: string } | null)?.rcpt === rcpt);
}

function hourKey(kind: string, at = new Date()) {
  return `ops:${kind}:${new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString().slice(0, 13)}`;
}

test.describe('mail sink and operator alerts', () => {
  test.skip(!local, 'drives the queue against the local database and local fake SMTP servers');

  test.beforeAll(async () => {
    relay = await startFakeSmtp();
    sink = await startFakeSmtp();
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(relay.port);
    process.env.SMTP_USER = 'mops-e2e';
    process.env.SMTP_PASS = 'mops-e2e';
    process.env.SMTP_FROM = 'noreply@example.test';
    process.env.MAIL_SINK_HOST = '127.0.0.1';
    process.env.MAIL_SINK_PORT = String(sink.port);
    process.env.MAIL_RECIPIENT_ALLOWLIST = 'allowed.example.test';
    process.env.ALERT_EMAIL_TO = `ops-${RUN}@example.test`;
    process.env.NEXTAUTH_SECRET ||= 'e2e-mail-ops-secret';
    delete process.env.MAIL_METER_MODE;
    delete process.env.MAIL_INLINE_TIMEOUT_MS;
    delete process.env.MAIL_QUEUE_LANES;
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
    resetMailOpsAlertsForTests();
    await clearBudget().catch(() => {});
    await prisma.job
      .deleteMany({ where: { name: 'email.send', idempotencyKey: { startsWith: 'mail:' } } })
      .catch(() => {});
    await prisma.job.deleteMany({ where: { idempotencyKey: { startsWith: `e2e-mops:${RUN}` } } }).catch(() => {});
    await prisma.job.deleteMany({ where: { idempotencyKey: { startsWith: 'ops:mail-' } } }).catch(() => {});
    await relay?.close();
    await sink?.close();
  });

  test.beforeEach(async () => {
    relay.mode = { kind: 'accept' };
    sink.mode = { kind: 'accept' };
    process.env.MAIL_SINK_PORT = String(sink.port);
    resetMailTransportsForTests();
    resetMailOpsAlertsForTests();
    takeRelayAuthRejected();
    await clearBudget();
  });

  test('with a sink, a stranger’s mail goes to the sink and an allowlisted one to the relay', async () => {
    const a = stranger('route');
    const b = allowed('route');
    expect(await sendEmail({ to: a, subject: 'to the sink', html: '<p>s</p>', category: 'message' })).toBe('SENT');
    expect(await sendEmail({ to: b, subject: 'to the relay', html: '<p>r</p>', category: 'message' })).toBe('SENT');
    expect(sink.to(a)).toHaveLength(1);
    expect(relay.to(a)).toHaveLength(0);
    expect(relay.to(b)).toHaveLength(1);
    expect(sink.to(b)).toHaveLength(0);
    // A critical mail takes the same rule.
    const c = stranger('critical');
    expect(await sendEmail({ to: c, subject: 'reset', html: '<p>c</p>', category: 'password-reset' })).toBe('SENT');
    expect(sink.to(c)).toHaveLength(1);
    expect(relay.to(c)).toHaveLength(0);
  });

  test('an unreachable sink queues the mail and retries the sink — it never falls back to the relay', async () => {
    const to = stranger('down');
    // A port nothing listens on: the connection is refused.
    const dead = await startFakeSmtp();
    const deadPort = dead.port;
    await dead.close();
    process.env.MAIL_SINK_PORT = String(deadPort);
    resetMailTransportsForTests();

    expect(await sendEmail({ to, subject: 'sink down', html: '<p>d</p>', category: 'message' })).toBe('QUEUED');
    const [job] = await jobsFor(to);
    expect(job.status).toBe('PENDING');
    expect(relay.to(to)).toHaveLength(0);

    // The drain tries the sink again, never the relay.
    await prisma.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await clearBudget();
    await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
    expect(relay.to(to)).toHaveLength(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PENDING');

    // The sink comes back: the queued mail reaches the sink.
    process.env.MAIL_SINK_PORT = String(sink.port);
    resetMailTransportsForTests();
    await clearBudget();
    await prisma.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await drainOnce({ maxMs: 5_000, deps: mailDrainDeps() });
    expect(sink.to(to)).toHaveLength(1);
    expect(relay.to(to)).toHaveLength(0);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
  });

  test('rejected credentials in the drain raise one relay-auth alert per hour', async () => {
    const to = allowed('eauth');
    relay.mode = { kind: 'refuse', stage: 'RCPT', reply: '452 4.2.2 Mailbox full' };
    expect(await sendEmail({ to, subject: 'eauth', html: '<p>e</p>', category: 'message' })).toBe('QUEUED');
    const [job] = await jobsFor(to);
    await prisma.job.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 1000) } });
    await clearBudget();

    const deps = mailDrainDeps();
    const summary = await drainOnce({
      maxMs: 5_000,
      deps: {
        ...deps,
        transmit: async () => {
          throw Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' });
        },
      },
    });
    expect(summary.authRejected).toBe(true);
    // Not charged to the message: the credentials are the relay's problem.
    const after = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe('PENDING');
    expect(after.attempts).toBe(job.attempts);

    const first = await evaluateMailOps({ authRejected: summary.authRejected, force: true });
    expect(first.raised).toContain('mail-relay-auth');
    const alert = await prisma.job.findUnique({ where: { idempotencyKey: hourKey('mail-relay-auth') } });
    expect(alert, 'the alert mail is queued under its hourly key').not.toBeNull();
    expect(JSON.stringify(alert!.payload)).not.toContain(to);
    // The same hour: nothing more, however often it is raised.
    noteRelayAuthRejected();
    const second = await evaluateMailOps({ force: true });
    expect(second.raised).not.toContain('mail-relay-auth');
    expect(await prisma.job.count({ where: { idempotencyKey: hourKey('mail-relay-auth') } })).toBe(1);
  });

  test('critical mail waiting over 5 minutes and a relay refusing over 15 raise their alerts', async () => {
    // A critical mail queued six minutes ago and still waiting.
    const waiting = await prisma.job.create({
      data: {
        name: 'email.send',
        status: 'PENDING',
        priority: 100,
        runAt: new Date(Date.now() + 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 6 * 60 * 1000),
        idempotencyKey: `e2e-mops:${RUN}:critical`,
        payload: { v: 1, lane: 'CRITICAL', category: 'password-reset', rcpt: 'c'.repeat(64), notAfter: new Date(Date.now() + 3_600_000).toISOString(), box: null },
      },
    });
    // A relay pause running now, in an outage that began twenty minutes ago.
    await prisma.mailBudget.create({
      data: {
        name: 'smtp',
        tat: new Date(),
        pauseLevel: 4,
        pausedUntil: new Date(Date.now() + 10 * 60 * 1000),
        pausedSince: new Date(Date.now() - 20 * 60 * 1000),
      },
    });
    const result = await evaluateMailOps({ force: true });
    expect(result.raised).toEqual(expect.arrayContaining(['mail-critical-waiting', 'mail-breaker-open']));
    expect(await prisma.job.findUnique({ where: { idempotencyKey: hourKey('mail-critical-waiting') } })).not.toBeNull();
    expect(await prisma.job.findUnique({ where: { idempotencyKey: hourKey('mail-breaker-open') } })).not.toBeNull();
    const logged = await prisma.activityLog.findFirst({ where: { action: 'mail_ops.alert' }, orderBy: { createdAt: 'desc' } });
    expect(logged?.detail ?? '').toContain('mail-');

    // A closed breaker and no credentials problem: neither of those is due.
    await prisma.job.delete({ where: { id: waiting.id } });
    await clearBudget();
    resetMailOpsAlertsForTests();
    const quiet = await evaluateMailOps({ force: true });
    expect(quiet.raised).not.toContain('mail-breaker-open');
    expect(quiet.raised).not.toContain('mail-relay-auth');
  });
});
