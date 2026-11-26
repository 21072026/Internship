import crypto from 'crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
// Static import, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// A sales owner hears about a lead somebody else put on their book (#3968).
// The routes themselves are covered by marketing-manual-lead.spec.ts and
// admin-bulk-candidates.spec.ts; this file pins only who is told, through the
// router's ledger (one `NotificationDelivery` per channel):
//   • an admin creating a lead for a rep (POST /api/admin/marketing-accounts,
//     `ownerId`) sends that rep the bell AND one e-mail
//     (`mentorship_request.menteeAssigned`);
//   • a lead the admin puts on their own book announces nothing;
//   • a bulk owner assignment (POST /api/admin/candidates/bulk, `assignOwner`)
//     sends the incoming owner ONE e-mail with the count
//     (`mentorship.bulkAssigned`), never one per row;
//   • the leads themselves are never told.

test.describe.configure({ mode: 'serial' });

const PW = 'LeadAssigned123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;

const orgIds: string[] = [];
const emails: string[] = [];
const ids: Record<string, string> = {};
const mail: Record<string, string> = {};

async function person(label: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', orgId: string) {
  const email = uniqueEmail(`assigned-${label}-${STAMP}`);
  emails.push(email);
  const user = await seedUser(email, PW, role, `Assigned ${label} ${STAMP}`, orgId);
  ids[label] = user.id;
  mail[label] = email;
  return user.id;
}

async function adminJar(playwright: { request: { newContext: (o: { baseURL?: string; extraHTTPHeaders?: Record<string, string> }) => Promise<APIRequestContext> } }, baseURL: string | undefined) {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  const res = await signInViaApi(ctx, mail.admin, PW, { host: MARKETING_HOST, headers: freshIp('assigned-admin') });
  expect(res.error, 'admin sign-in').toBeNull();
  return ctx;
}

const emailDeliveries = (userId: string, eventKey: string) =>
  prisma.notificationDelivery.findMany({ where: { userId, eventKey, channel: 'email' }, select: { status: true } });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Assigned ${STAMP}`, slug: `assigned-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  ids.org = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId: org.id, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  await person('admin', 'ADMIN', org.id);
  await person('rep1', 'MENTOR', org.id);
  await person('rep2', 'MENTOR', org.id);
  // Two leads on rep1's book, for the bulk move to rep2.
  for (const label of ['bulk1', 'bulk2']) {
    const menteeId = await person(label, 'MENTEE', org.id);
    await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: ids.rep1, menteeId, pipelineStatus: 'LEAD_QUALIFIED' } });
  }
});

test.afterAll(async () => {
  const userIds = Object.entries(ids).filter(([k]) => k !== 'org').map(([, v]) => v);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.notificationDelivery.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  const rels = await prisma.mentorshipRelation.findMany({ where: { orgId: { in: orgIds } }, select: { menteeId: true } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  const leads = await prisma.user.findMany({ where: { id: { in: rels.map((r) => r.menteeId) } }, select: { email: true } });
  for (const email of [...emails, ...leads.map((l) => l.email)]) await cleanupByEmail(email);
  await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('an admin creating a lead for a rep mails that rep; one for themself mails nobody', async ({ playwright, baseURL }) => {
  test.slow();
  const admin = await adminJar(playwright, baseURL);

  const forRep = await admin.post('/api/admin/marketing-accounts', {
    data: { name: `Assigned Co ${STAMP}`, contactName: 'Ada Example', contactEmail: `ada-${STAMP}@example.test`, ownerId: ids.rep1 },
  });
  expect(forRep.status(), await forRep.text()).toBe(201);
  expect(await prisma.notification.count({ where: { userId: ids.rep1, type: 'mentorship_request.menteeAssigned' } })).toBe(1);
  const mailed = await emailDeliveries(ids.rep1, 'mentorship_request.menteeAssigned');
  expect(mailed).toHaveLength(1);
  expect(mailed[0].status).not.toBe('SKIPPED');
  // The lead is never told.
  const created = (await forRep.json()) as { leadId: string | null };
  if (created.leadId) expect(await prisma.notification.count({ where: { userId: created.leadId } })).toBe(0);

  const forSelf = await admin.post('/api/admin/marketing-accounts', {
    data: { name: `Own Co ${STAMP}`, contactName: 'Bo Example', contactEmail: `bo-${STAMP}@example.test`, ownerId: ids.admin },
  });
  expect(forSelf.status(), await forSelf.text()).toBe(201);
  expect(await emailDeliveries(ids.admin, 'mentorship_request.menteeAssigned')).toHaveLength(0);
  await admin.dispose();
});

test('a bulk owner assignment sends the incoming owner one mail with the count', async ({ playwright, baseURL }) => {
  test.slow();
  const admin = await adminJar(playwright, baseURL);
  const res = await admin.post('/api/admin/candidates/bulk', {
    data: { action: 'assignOwner', ownerId: ids.rep2, candidateIds: [ids.bulk1, ids.bulk2] },
  });
  expect(res.status(), await res.text()).toBe(200);
  const mailed = await emailDeliveries(ids.rep2, 'mentorship.bulkAssigned');
  expect(mailed).toHaveLength(1);
  expect(mailed[0].status).not.toBe('SKIPPED');
  // One mail, not one per row: the per-row assignment notice stays silent.
  expect(await emailDeliveries(ids.rep2, 'mentorship_request.menteeAssigned')).toHaveLength(0);
  await admin.dispose();
});
