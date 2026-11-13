import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST, signInViaApi } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * The sales dispatcher (#3656, src/lib/salesDispatcher.ts): an ORG_ADMIN marks a
 * sales rep, who then sees and works every sales record of the org like its
 * owner. What this pins:
 *   - only an ORG_ADMIN grants it (user.write), only to an active rep of the
 *     own org, only on a vertical with the sales board; it is audited;
 *   - granted, the rep reads colleagues' records on the board list, moves their
 *     stage, logs interactions and opens their lead page;
 *   - never another tenant's record; a plain rep still cannot;
 *   - revoked, the reach is gone on the next request (no session to revoke);
 *   - the flag on an INTERNSHIP mentor is inert.
 *
 * SYNTHETIC ONLY: throwaway orgs.
 */

const PW = 'Dispatcher123!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const mail: Record<string, string> = {};
const ids: Record<string, string> = {};
const orgIds: string[] = [];
const contexts: APIRequestContext[] = [];
const api: Record<string, APIRequestContext> = {};

test.describe.configure({ mode: 'serial' });

async function org(label: string, vertical: 'MARKETING' | 'INTERNSHIP') {
  const id = (await prisma.organization.create({ data: { name: `Disp ${label} ${STAMP}`, slug: `disp-${label}-${STAMP}`, vertical } })).id;
  orgIds.push(id);
  if (vertical === 'MARKETING') {
    await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: id })) });
  }
  return id;
}

async function person(label: string, role: 'ADMIN' | 'MENTOR', orgId: string) {
  mail[label] = uniqueEmail(`disp-${label}`);
  ids[label] = (await seedUser(mail[label], PW, role, `Disp ${label} ${STAMP}`, orgId)).id;
}

async function record(label: string, ownerId: string, orgId: string, stage = 'LEAD_NEW') {
  const lead = await prisma.user.create({
    data: { orgId, email: `disp-${label}-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: `Lead ${label} ${STAMP}`, skills: [] },
  });
  ids[label] = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ownerId, menteeId: lead.id, pipelineStatus: stage } })).id;
}

test.beforeAll(async ({ playwright, baseURL }) => {
  const a = await org('a', 'MARKETING');
  const b = await org('b', 'MARKETING');
  const intern = await org('i', 'INTERNSHIP');
  ids.orgA = a;
  await person('admin', 'ADMIN', a);
  await person('observer', 'ADMIN', a);
  await prisma.user.update({ where: { id: ids.observer }, data: { adminLevel: 'OBSERVER' } });
  await person('disp', 'MENTOR', a);
  await person('repB', 'MENTOR', a);
  await person('repC', 'MENTOR', a);
  await person('foreignRep', 'MENTOR', b);
  await person('intAdmin', 'ADMIN', intern);
  await person('intMentor', 'MENTOR', intern);
  await person('intMentor2', 'MENTOR', intern);
  await record('recB', ids.repB, a);
  await record('foreign', ids.foreignRep, b);
  // INTERNSHIP: a mentor holding the flag in the database, and a colleague's relation.
  await prisma.user.update({ where: { id: ids.intMentor }, data: { salesDispatcher: true } });
  const mentee = await prisma.user.create({ data: { orgId: intern, email: `disp-imentee-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: `IMentee ${STAMP}`, skills: [] } });
  ids.intRel = (await prisma.mentorshipRelation.create({ data: { orgId: intern, mentorId: ids.intMentor2, menteeId: mentee.id } })).id;

  for (const label of ['admin', 'observer', 'disp', 'repC', 'intAdmin', 'intMentor']) {
    const internship = label.startsWith('int');
    const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: internship ? {} : host });
    expect((await signInViaApi(ctx, mail[label], PW, internship ? {} : { host: MARKETING_HOST })).ok, label).toBe(true);
    contexts.push(ctx);
    api[label] = ctx;
  }
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of orgIds) {
    await prisma.interactionLog.deleteMany({ where: { relation: { orgId: id } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { orgId: id, email: { endsWith: '@import.local' } } }).catch(() => {});
    await prisma.pipelineStage.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of Object.values(mail)) await cleanupByEmail(e);
  for (const id of orgIds) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

const grant = (who: string, userId: string, enabled: boolean) =>
  api[who].post(`/api/admin/users/${userId}/sales-dispatcher`, { headers: who.startsWith('int') ? {} : host, data: { enabled } });
const boardIds = async (who: string) =>
  ((await (await api[who].get('/api/mentorship', { headers: host })).json()).relations as { id: string }[]).map((r) => r.id);
const moveStage = (who: string, relationId: string, pipelineStatus: string) =>
  api[who].put(`/api/mentorship/${relationId}`, { headers: host, data: { pipelineStatus } });

test('only an org admin grants it, to an active rep of the own org, on a sales vertical', { tag: '@smoke' }, async () => {
  expect((await grant('observer', ids.disp, true)).status()).toBe(403);
  expect((await grant('repC', ids.disp, true)).status()).toBe(403);
  expect((await grant('admin', ids.foreignRep, true)).status()).toBe(404);
  expect(await (await grant('admin', ids.admin, true)).json()).toMatchObject({ code: 'not_a_rep' });
  expect(await (await grant('intAdmin', ids.intMentor2, true)).json()).toMatchObject({ code: 'not_sales' });

  // Before the grant the rep is a rep: their own records only.
  expect(await boardIds('disp')).not.toContain(ids.recB);
  expect((await moveStage('disp', ids.recB, 'LEAD_CONTACTED')).status()).toBe(403);

  const res = await grant('admin', ids.disp, true);
  expect(res.status()).toBe(200);
  expect(await prisma.auditLog.count({ where: { orgId: ids.orgA, action: 'sales.dispatcher_granted', targetId: ids.disp } })).toBe(1);
});

test('the dispatcher sees and works a colleague’s record — never another tenant’s; a plain rep still cannot', { tag: '@smoke' }, async () => {
  const seen = await boardIds('disp');
  expect(seen).toContain(ids.recB);
  expect(seen).not.toContain(ids.foreign);

  expect((await moveStage('disp', ids.recB, 'LEAD_CONTACTED')).status()).toBe(200);
  expect((await prisma.mentorshipRelation.findUnique({ where: { id: ids.recB } }))!.pipelineStatus).toBe('LEAD_CONTACTED');
  const logged = await api.disp.post('/api/interactions', {
    headers: host,
    data: { relationId: ids.recB, date: new Date().toISOString(), type: 'Call', notes: 'Dispatcher called' },
  });
  expect(logged.status()).toBeLessThan(300);

  // Another tenant's record: no reach, whatever the flag.
  expect([403, 404]).toContain((await moveStage('disp', ids.foreign, 'LEAD_CONTACTED')).status());
  // A colleague without the flag.
  expect((await moveStage('repC', ids.recB, 'LEAD_QUALIFIED')).status()).toBe(403);
  expect(await boardIds('repC')).not.toContain(ids.recB);
});

test('the dispatcher is an owner, not an admin: the admin-only fields stay closed', { tag: '@smoke' }, async () => {
  // Re-pointing a record at an account is an admin's (TARGET_ADMIN_ONLY) — not the owner's, not the dispatcher's.
  const account = await prisma.company.create({ data: { orgId: ids.orgA, name: `Disp Account ${STAMP}` } });
  const res = await api.disp.put(`/api/mentorship/${ids.recB}`, { headers: host, data: { companyId: account.id } });
  expect(res.status()).toBe(403);
  expect((await prisma.mentorshipRelation.findUnique({ where: { id: ids.recB } }))!.companyId).toBeNull();
  await prisma.company.delete({ where: { id: account.id } });
});

test('the dispatcher opens a colleague’s lead page; a plain rep gets a 404', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, mail.disp, PW, '/sales');
  const ok = await page.goto(`/sales/leads/${ids.recB}`);
  expect(ok?.status()).toBe(200);
  await expect(page.getByTestId('sales-lead-name')).toHaveText(`Lead recB ${STAMP}`);

  const res = await api.repC.get(`/sales/leads/${ids.recB}`, { headers: host });
  expect(res.status()).toBe(404);
});

test('revoked, the reach is gone on the next request', { tag: '@smoke' }, async () => {
  expect((await grant('admin', ids.disp, false)).status()).toBe(200);
  expect(await boardIds('disp')).not.toContain(ids.recB);
  expect((await moveStage('disp', ids.recB, 'LEAD_QUALIFIED')).status()).toBe(403);
  expect(await prisma.auditLog.count({ where: { orgId: ids.orgA, action: 'sales.dispatcher_revoked', targetId: ids.disp } })).toBe(1);
});

test('deactivating a dispatcher clears the flag, so a reactivation brings nothing back', async () => {
  expect((await grant('admin', ids.disp, true)).status()).toBe(200);
  const off = await api.admin.patch(`/api/users/${ids.disp}`, { headers: host, data: { isActive: false } });
  expect(off.status()).toBe(200);
  expect((await prisma.user.findUnique({ where: { id: ids.disp } }))!.salesDispatcher).toBe(false);
  await api.admin.patch(`/api/users/${ids.disp}`, { headers: host, data: { isActive: true } });
  expect((await prisma.user.findUnique({ where: { id: ids.disp } }))!.salesDispatcher).toBe(false);
});

test('the flag on an INTERNSHIP mentor grants nothing', { tag: '@smoke' }, async () => {
  const res = await api.intMentor.get('/api/mentorship');
  expect(res.status()).toBe(200);
  expect(((await res.json()).relations as { id: string }[]).map((r) => r.id)).not.toContain(ids.intRel);
  expect((await api.intMentor.put(`/api/mentorship/${ids.intRel}`, { data: { status: 'ACTIVE' } })).status()).toBe(403);
});
