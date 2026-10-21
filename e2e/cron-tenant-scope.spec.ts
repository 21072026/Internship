import { test, expect, request as playwrightRequest } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

/**
 * `GET /api/cron` is one tenant's button and the operator's trigger at once
 * (#1575). A tenant ADMIN may run the jobs that read their own org from the
 * session, and `job=trial-reminders&orgId=` for their OWN org — never another
 * tenant's sweep (its mails, bells and TRIAL_ACTIVE → TRIAL_EXPIRED moves), and
 * never a platform-wide one, which sweeps every tenant and answers with
 * instance-wide totals. Those take a super admin of the target's world, and a
 * refusal leaves an `authz.scope_denied` row.
 */

const PW = 'CronScope123!';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const stamp = `${Date.now()}`;
const ownAdminEmail = uniqueEmail('cron-scope-admin');
let ownOrgId = '';
let foreignOrgId = '';
let ownAdminId = '';

test.beforeAll(async () => {
  ownOrgId = (await prisma.organization.create({ data: { name: `Cron Scope Own ${stamp}`, slug: `cron-own-${stamp}` } })).id;
  foreignOrgId = (
    await prisma.organization.create({ data: { name: `Cron Scope Foreign ${stamp}`, slug: `cron-foreign-${stamp}`, vertical: 'MARKETING' } })
  ).id;
  ownAdminId = (await seedUser(ownAdminEmail, PW, 'ADMIN', 'Cron Scope Admin', ownOrgId)).id;
});

test.afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { actorId: ownAdminId } }).catch(() => {});
  await cleanupByEmail(ownAdminEmail);
  await prisma.organization.deleteMany({ where: { id: { in: [ownOrgId, foreignOrgId] } } }).catch(() => {});
  await prisma.$disconnect();
});

test('a tenant admin cannot run another tenant’s or a platform-wide cron job (#1575)', { tag: '@smoke' }, async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    expect((await signInViaApi(ctx, ownAdminEmail, PW)).ok).toBe(true);

    // Another tenant's trial sweep: refused, and nothing about it is answered.
    const foreign = await ctx.get(`/api/cron?job=trial-reminders&orgId=${foreignOrgId}`);
    expect(foreign.status()).toBe(403);
    expect(await foreign.json()).not.toHaveProperty('trialReminders');

    // The platform-wide sweeps — named, unnamed (the batch) and unknown names,
    // which fall through to the batch — are the operator's.
    for (const path of ['/api/cron', '/api/cron?job=usage-rollup', '/api/cron?job=retention-prune', '/api/cron?job=no-such-job']) {
      expect((await ctx.get(path)).status(), path).toBe(403);
    }

    // Each refusal is audited against the caller.
    expect(
      await prisma.activityLog.count({ where: { actorId: ownAdminId, action: 'authz.scope_denied' } }),
    ).toBeGreaterThanOrEqual(5);

    // What stays theirs: their own org's trial sweep, and a job that reads the
    // org from the session.
    const own = await ctx.get(`/api/cron?job=trial-reminders&orgId=${ownOrgId}`);
    expect(own.status()).toBe(200);
    expect((await own.json()).trialReminders).toBeTruthy();
    expect((await ctx.get('/api/cron?job=relation-health')).status()).toBe(200);
  } finally {
    await ctx.dispose();
  }
});

test('a super admin reaches only the organizations of its own world (#1575, #2647)', { tag: '@smoke' }, async () => {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    // The seeded admin is the INTERNSHIP world's super admin, signed in on its
    // host: a MARKETING tenant's sweep is not in its reach.
    expect((await signInViaApi(ctx, ADMIN_EMAIL, ADMIN_PASSWORD)).ok).toBe(true);
    expect((await ctx.get(`/api/cron?job=trial-reminders&orgId=${foreignOrgId}`)).status()).toBe(403);
    // An organization of its own world is.
    expect((await ctx.get(`/api/cron?job=trial-reminders&orgId=${ownOrgId}`)).status()).toBe(200);
  } finally {
    await ctx.dispose();
  }
});
