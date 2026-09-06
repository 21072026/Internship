import { test, expect } from '@playwright/test';
import { E2E_HEALTH_TOKEN, E2E_ALERT_EMAIL_TO } from '../playwright.config';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// Job-queue visibility (#1674): queue depth and dead-letter size on the gated
// half of /api/health, and one daily alert mail that is SILENT while the
// dead-letter queue is empty.
//
// Two properties are worth more than the counters themselves and both are
// asserted below: an anonymous caller pays nothing for this (the endpoint is in
// the nightly k6 mix with a latency budget), and a clean queue produces no mail
// and no EmailLog row at all.
const local = !process.env.BASE_URL;

// Every row this spec creates carries this prefix in `Job.name`, which is also
// how the cleanup finds them again. Unique per run so parallel workers and a
// long-lived dev database never trip over each other.
const RUN = `e2e.jobs-${Date.now().toString(36)}`;
const DLQ_SUBJECT_PREFIX = '[CRM] Ölü mektup';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('queue counters are gated and opt-in, and the dead-letter alert is silent while green', async ({
  page,
  request,
}) => {
  test.skip(!local, 'seeds Job rows directly — local DB only');

  const adminEmail = uniqueEmail('jobs-health-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Jobs Health Admin');

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const seededJobs: string[] = [];
  const mkJob = async (name: string, status: 'PENDING' | 'RUNNING' | 'DEAD_LETTER', over: Record<string, unknown> = {}) => {
    const row = await prisma.job.create({
      data: { name: `${RUN}.${name}`, payload: {}, status, ...over },
    });
    seededJobs.push(row.id);
    return row;
  };

  try {
    // Two overdue pending jobs and one running one.
    await mkJob('pending', 'PENDING', { runAt: tenMinutesAgo });
    await mkJob('pending', 'PENDING', { runAt: tenMinutesAgo });
    await mkJob('running', 'RUNNING', { lockedAt: new Date(), lockedBy: 'e2e-worker' });

    // 1) An anonymous caller sees liveness only — asking for the counters does
    //    not get them, and (the point) does not cost a query either.
    const anon = await request.get('/api/health?jobs=1');
    expect(anon.status()).toBe(200);
    expect((await anon.json()).jobs).toBeUndefined();

    // 2) The detail view without ?jobs=1 stays exactly as expensive as it was.
    const detailNoOptIn = await request.get('/api/health', {
      headers: { 'X-Health-Token': E2E_HEALTH_TOKEN },
    });
    const detailBody = await detailNoOptIn.json();
    expect(detailBody.version).toBeTruthy(); // the gate did open…
    expect(detailBody.jobs).toBeUndefined(); // …and the counters still cost nothing

    // 3) Gated + opted in: the counters. Other specs run in parallel and the
    //    dev database is long-lived, so these are lower bounds.
    const gated = await request.get('/api/health?jobs=1', {
      headers: { 'X-Health-Token': E2E_HEALTH_TOKEN },
    });
    expect(gated.status()).toBe(200);
    const jobs = (await gated.json()).jobs;
    expect(Object.keys(jobs).sort()).toEqual([
      'deadLetter',
      'failedLast24h',
      'oldestPendingAgeSec',
      'pending',
      'running',
    ]);
    expect(jobs.pending).toBeGreaterThanOrEqual(2);
    expect(jobs.running).toBeGreaterThanOrEqual(1);
    // Depth alone cannot tell a burst from a stalled worker; the age can.
    expect(jobs.oldestPendingAgeSec).toBeGreaterThanOrEqual(9 * 60);
    // Operational metadata only — no name, no payload, no tenant.
    expect(JSON.stringify(jobs)).not.toContain(RUN);
    expect(JSON.stringify(jobs)).not.toContain('orgId');

    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // 4) Green is silent. Only meaningful while nothing else has dead-lettered.
    const foreignDeadLetters = await prisma.job.count({
      where: { status: 'DEAD_LETTER', name: { not: { startsWith: RUN } } },
    });
    const mailsBefore = await prisma.emailLog.count({ where: { subject: { startsWith: DLQ_SUBJECT_PREFIX } } });
    if (foreignDeadLetters === 0) {
      const quiet = await page.request.get('/api/cron?job=dlq-alert');
      expect(quiet.ok()).toBeTruthy();
      expect((await quiet.json()).dlqAlert).toEqual({ sent: false, total: 0 });
      // The whole convention in one assertion: nothing was sent, so nothing was
      // logged either.
      const after = await prisma.emailLog.count({ where: { subject: { startsWith: DLQ_SUBJECT_PREFIX } } });
      expect(after).toBe(mailsBefore);
    }

    // 5) Three dead-lettered jobs across two names and two failure reasons.
    await mkJob('send', 'DEAD_LETTER', { attempts: 5, lastError: 'Connection refused' });
    await mkJob('send', 'DEAD_LETTER', { attempts: 5, lastError: 'Connection refused' });
    await mkJob('report', 'DEAD_LETTER', { attempts: 5, lastError: 'ETIMEDOUT after 30s' });

    const loud = await page.request.get('/api/cron?job=dlq-alert');
    expect(loud.ok()).toBeTruthy();
    const result = (await loud.json()).dlqAlert;
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.sent).toBe(true);

    // Exactly one mail, to the operator address, recorded in the ledger. SMTP is
    // blanked for e2e, so the row is SKIPPED rather than SENT — what matters is
    // that one row exists and that it is the ops-alert category.
    const mailsAfter = await prisma.emailLog.count({ where: { subject: { startsWith: DLQ_SUBJECT_PREFIX } } });
    expect(mailsAfter).toBe(mailsBefore + 1);
    const mail = await prisma.emailLog.findFirst({
      where: { subject: { startsWith: DLQ_SUBJECT_PREFIX } },
      orderBy: { createdAt: 'desc' },
    });
    expect(mail?.to).toBe(E2E_ALERT_EMAIL_TO);
    expect(mail?.category).toBe('ops-alert');
    expect(mail?.subject).toContain('iş bekliyor');

    // …and the counters now show the same three.
    const withDlq = await request.get('/api/health?jobs=1', {
      headers: { 'X-Health-Token': E2E_HEALTH_TOKEN },
    });
    const dlqCounters = (await withDlq.json()).jobs;
    expect(dlqCounters.deadLetter).toBeGreaterThanOrEqual(3);
    expect(dlqCounters.failedLast24h).toBeGreaterThanOrEqual(3);
  } finally {
    await prisma.job.deleteMany({ where: { name: { startsWith: RUN } } });
    await prisma.emailLog.deleteMany({ where: { subject: { startsWith: DLQ_SUBJECT_PREFIX } } });
    await cleanupByEmail(adminEmail);
  }
});
