import { test, expect, request as playwrightRequest } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

/**
 * `GET /api/cron?job=…&enqueue=1` (#1677) hands the named job to the queue
 * instead of running it in the request: a `Job` row with `trigger: 'manual'`,
 * which the worker runs with retries and a JobRun an operator can tell apart
 * from a scheduled one. The authorization is the route's existing one (#1575)
 * and is applied BEFORE anything is enqueued: an own-org job carries the
 * caller's org and nothing wider, a platform job is a super admin's.
 */

const PW = 'CronEnqueue123!';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const stamp = `${Date.now()}`;
const tenantAdminEmail = uniqueEmail('cron-enqueue-admin');
let orgId = '';
const createdJobs: string[] = [];

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Cron Enqueue ${stamp}`, slug: `cron-enq-${stamp}` } })).id;
  await seedUser(tenantAdminEmail, PW, 'ADMIN', 'Cron Enqueue Admin', orgId);
});

test.afterAll(async () => {
  await prisma.job.deleteMany({ where: { id: { in: createdJobs } } }).catch(() => {});
  await cleanupByEmail(tenantAdminEmail);
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('a tenant admin enqueues an own-org job for their org only, and no platform job (#1677)', { tag: '@smoke' }, async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    expect((await signInViaApi(ctx, tenantAdminEmail, PW)).ok).toBe(true);

    const res = await ctx.get('/api/cron?job=relation-health&enqueue=1&at=2026-10-01T00:00:00Z');
    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0].name).toBe('relationHealth.sweep');
    createdJobs.push(body.jobs[0].id);

    const row = await prisma.job.findUniqueOrThrow({ where: { id: body.jobs[0].id } });
    expect(row.trigger).toBe('manual');
    expect(row.orgId).toBe(orgId);
    expect(row.payload).toEqual({ orgIds: [orgId], at: '2026-10-01T00:00:00Z' });

    // The gate comes first: a platform job, and the batch, are still refused —
    // and nothing is queued for them.
    const before = await prisma.job.count({ where: { trigger: 'manual', name: 'usage.rollup' } });
    expect((await ctx.get('/api/cron?job=usage-rollup&enqueue=1')).status()).toBe(403);
    expect((await ctx.get('/api/cron?enqueue=1')).status()).toBe(403);
    expect(await prisma.job.count({ where: { trigger: 'manual', name: 'usage.rollup' } })).toBe(before);
  } finally {
    await ctx.dispose();
  }
});

test('a super admin enqueues a platform job; the batch and unknown jobs are not enqueueable', async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    expect((await signInViaApi(ctx, ADMIN_EMAIL, ADMIN_PASSWORD)).ok).toBe(true);

    const res = await ctx.get('/api/cron?job=email-health&enqueue=1');
    expect(res.status()).toBe(202);
    const { jobs } = await res.json();
    createdJobs.push(jobs[0].id);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: jobs[0].id } });
    expect(row).toMatchObject({ name: 'email.healthCheck', trigger: 'manual', orgId: null });

    for (const path of ['/api/cron?enqueue=1', '/api/cron?job=re-engagement&enqueue=1', '/api/cron?job=no-such-job&enqueue=1']) {
      expect((await ctx.get(path)).status(), path).toBe(400);
    }
  } finally {
    await ctx.dispose();
  }
});
