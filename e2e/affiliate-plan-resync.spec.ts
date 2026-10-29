import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { runPlanResync, PlanResyncIncomplete } from '../src/lib/affiliatePlanResync';
import { RESYNC_END, queuedResync } from '../src/lib/affiliatePlanResyncRule';

/**
 * The partners' re-evaluation after a plan change runs on the queue (#3170,
 * docs/affiliate-module.md): the save answers once the plan is committed, whatever
 * the number of partners, and the settings report the job's progress.
 *
 * - The request returns before the partners are judged; the job then judges all
 *   of them, once each (one `affiliate.commissions.resync` audit row per partner).
 * - The job body, run in-process on a programme no job was queued for: it resumes
 *   after its cursor, retries exactly its failures, ends INCOMPLETE on the last
 *   attempt, and stops when a newer plan version took over.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs per run.
 */

const PW = 'AffResync123!';
const host = asHost(MARKETING_HOST);
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 1_000, commissionMinor: 300 }],
  topCommissionMinor: 900,
  percentBps: 1_000,
  switchAtCustomer: null,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};
const PARTNERS = 60;

const orgIds: string[] = [];
const emails: string[] = [];
const contexts: APIRequestContext[] = [];

async function newOrg(label: string, partners: number) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const id = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-rs-${label}-${stamp}`, vertical: 'MARKETING' } })).id;
  orgIds.push(id);
  await prisma.affiliatePartner.createMany({ data: Array.from({ length: partners }, (_, i) => ({ orgId: id, code: `rs-${i}`, displayName: `Resync ${i}` })) });
  return id;
}
const resyncAudits = (orgId: string) => prisma.auditLog.count({ where: { orgId, action: 'affiliate.commissions.resync' } });

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of orgIds) {
    await prisma.job.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of emails) await cleanupByEmail(e);
  for (const id of orgIds) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('the save answers before the partners are judged; the queued job judges each once', async ({ playwright, baseURL }) => {
  const orgId = await newOrg('api', PARTNERS);
  const email = uniqueEmail('aff-rs-owner');
  emails.push(email);
  await seedUser(email, PW, 'ADMIN', 'Resync Admin', { orgId });
  const owner = await playwright.request.newContext({ baseURL });
  contexts.push(owner);
  expect((await signInViaApi(owner, email, PW, { host: MARKETING_HOST })).ok).toBe(true);

  const res = await owner.put('/api/admin/affiliate/settings/plan', { headers: host, data: PLAN });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ changed: true, planVersion: 1, resync: { v: 1 } });
  expect(['QUEUED', 'RUNNING']).toContain(body.resync.status);
  expect(body.resync.done).toBeLessThan(PARTNERS);
  expect(await prisma.job.count({ where: { orgId, name: 'affiliate.planResync' } })).toBe(1);

  await expect
    .poll(async () => (await (await owner.get('/api/admin/affiliate/settings', { headers: host })).json()).planResync?.status, { timeout: 90_000, intervals: [1_000, 2_000] })
    .toBe('DONE');
  const settings = await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId }, select: { planResync: true } });
  expect(settings.planResync).toMatchObject({ v: 1, total: PARTNERS, done: PARTNERS, failed: 0, cursor: RESYNC_END });
  expect(await resyncAudits(orgId)).toBe(PARTNERS);

  // An unchanged save queues nothing.
  expect(await (await owner.put('/api/admin/affiliate/settings/plan', { headers: host, data: PLAN })).json()).toMatchObject({ changed: false, resync: null });
  expect(await prisma.job.count({ where: { orgId, name: 'affiliate.planResync' } })).toBe(1);
});

test('the job body resumes after its cursor, retries its failures, and yields to a newer plan', async () => {
  const orgId = await newOrg('body', 5);
  const ids = (await prisma.affiliatePartner.findMany({ where: { orgId }, orderBy: { id: 'asc' }, select: { id: true } })).map((p) => p.id);
  const signal = new AbortController().signal;
  const state = (patch: object) => ({ ...queuedResync(1, new Date()), ...patch });
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date(), planResync: state({ status: 'RUNNING', total: 5, done: 2, cursor: ids[1] }) } });

  // A crashed run had finished two partners: the rerun judges the other three only.
  const summary = await runPlanResync({ planVersion: 1, actorId: 'system' }, orgId, { attempt: 2, maxAttempts: 5, signal });
  expect(summary).toMatchObject({ partners: 5, resynced: 5, failed: 0 });
  const judged = await prisma.auditLog.findMany({ where: { orgId, action: 'affiliate.commissions.resync' }, select: { targetId: true } });
  expect(judged.map((r) => r.targetId).sort()).toEqual(ids.slice(2).sort());

  // A retry list with a partner that cannot be judged: thrown while attempts remain…
  const ghost = 'ghost-partner-id';
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { planResync: state({ status: 'RETRYING', total: 5, done: 4, failed: 2, cursor: RESYNC_END, retry: [ids[0], ghost] }) } });
  await expect(runPlanResync({ planVersion: 1, actorId: 'system' }, orgId, { attempt: 2, maxAttempts: 3, signal })).rejects.toBeInstanceOf(PlanResyncIncomplete);
  expect((await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } })).planResync).toMatchObject({ status: 'RETRYING', done: 5, failed: 1, retry: [ghost] });
  // …INCOMPLETE on the last one: that partner's next payment write re-evaluates it.
  expect(await runPlanResync({ planVersion: 1, actorId: 'system' }, orgId, { attempt: 3, maxAttempts: 3, signal })).toMatchObject({ failed: 1 });
  expect((await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } })).planResync).toMatchObject({ status: 'INCOMPLETE', failed: 1 });

  // A job for an older version stops without touching the newer state.
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { planVersion: 2, planResync: state({ v: 2 }) } });
  const before = await resyncAudits(orgId);
  expect(await runPlanResync({ planVersion: 1, actorId: 'system' }, orgId, { attempt: 1, maxAttempts: 3, signal })).toEqual({ superseded: 1 });
  expect(await resyncAudits(orgId)).toBe(before);
  expect((await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } })).planResync).toMatchObject({ v: 2, status: 'QUEUED' });
});
