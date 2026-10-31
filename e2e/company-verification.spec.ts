import { test, expect, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Employer verification (#1865, docs/company-verification.md). A company that is
// not VERIFIED reaches no candidate: its open roles are absent from the mentee
// board — and from its total, because the gate is in the WHERE — it cannot
// publish a role and it cannot open the candidate channel. An admin approves it
// (audited, the company told) and its roles appear. A COMPANY user edits its
// own profile's six fields and nothing else.

const PW = 'CompanyVerify123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const emails = {
  admin: uniqueEmail('cv-admin'),
  mentee: uniqueEmail('cv-mentee'),
  company: uniqueEmail('cv-company'),
  other: uniqueEmail('cv-other-company'),
};
const ids: Record<string, string> = {};
let org: { id: string };
let admin: APIRequestContext;
let mentee: APIRequestContext;
let company: APIRequestContext;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  const hash = await bcrypt.hash(PW, 10);
  org = await prisma.organization.create({ data: { name: `CV Org ${stamp}`, slug: `cv-${stamp}` }, select: { id: true } });
  // The company that existed before verification: no status given, so the
  // column default — VERIFIED — applies, exactly as on deploy.
  ids.legacy = (await prisma.company.create({ data: { orgId: org.id, name: `Acme Legacy ${stamp}` }, select: { id: true } })).id;
  ids.pending = (await prisma.company.create({ data: { orgId: org.id, name: `Acme Pending ${stamp}`, verificationStatus: 'PENDING', quota: 3 }, select: { id: true } })).id;
  const mk = (email: string, role: 'ADMIN' | 'MENTEE' | 'COMPANY', companyId?: string) =>
    prisma.user.create({ data: { email, password: hash, role, orgId: org.id, fullName: `CV ${role}`, skills: [], ...(companyId ? { companyId } : {}) }, select: { id: true } });
  ids.admin = (await mk(emails.admin, 'ADMIN')).id;
  ids.mentee = (await mk(emails.mentee, 'MENTEE')).id;
  ids.companyUser = (await mk(emails.company, 'COMPANY', ids.pending)).id;
  await mk(emails.other, 'COMPANY', ids.legacy);
  const req = (key: string, companyId: string, status: string) =>
    prisma.requisition.create({ data: { orgId: org.id, companyId, title: `${key} role ${stamp}`, status, openings: 1, requiredSkills: [] }, select: { id: true } }).then((r) => { ids[key] = r.id; });
  await req('legacyOpen', ids.legacy, 'OPEN');
  // An OPEN role of a pending company — e.g. one an admin opened before the
  // company was flagged: still invisible.
  await req('pendingOpen', ids.pending, 'OPEN');
  await req('pendingDraft', ids.pending, 'DRAFT');

  const baseURL = info.project.use.baseURL;
  [admin, mentee, company] = await Promise.all([1, 2, 3].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(admin, emails.admin, PW)).ok).toBe(true);
  expect((await signInViaApi(mentee, emails.mentee, PW)).ok).toBe(true);
  expect((await signInViaApi(company, emails.company, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([admin, mentee, company].map((c) => c?.dispose()));
  await prisma.notification.deleteMany({ where: { userId: { in: Object.values(ids) } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { targetId: { in: [ids.pending, ids.legacy] } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { targetId: { in: [ids.pending, ids.legacy] } } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: org?.id } }).catch(() => {});
  await prisma.$disconnect();
});

async function board() {
  const res = await mentee.get('/api/portal/requisitions?pageSize=50');
  expect(res.status()).toBe(200);
  const body = await res.json();
  return { ids: (body.jobs as { id: string }[]).map((j) => j.id), total: body.total as number };
}

test('a pending company is invisible on the board, in the total and at its detail URL', { tag: '@smoke' }, async () => {
  const before = await board();
  expect(before.ids).toContain(ids.legacyOpen);
  expect(before.ids).not.toContain(ids.pendingOpen);
  expect(before.total).toBe(1);
  expect((await mentee.get(`/api/portal/requisitions/${ids.pendingOpen}`)).status()).toBe(404);
});

test('a pending company cannot publish a role or open the candidate channel, but may draft', { tag: '@smoke' }, async () => {
  const create = await company.post('/api/requisitions', { data: { title: `New role ${stamp}`, status: 'OPEN', openings: 1, filled: 0, requiredSkills: [] } });
  expect(create.status()).toBe(403);
  expect((await create.json()).code).toBe('company_not_verified');
  const draft = await company.post('/api/requisitions', { data: { title: `Draft role ${stamp}`, status: 'DRAFT', openings: 1, filled: 0, requiredSkills: [] } });
  expect(draft.status()).toBe(201);
  const publish = await company.patch(`/api/requisitions/${ids.pendingDraft}`, { data: { status: 'OPEN' } });
  expect(publish.status()).toBe(403);
  expect((await publish.json()).code).toBe('company_not_verified');
  expect((await prisma.requisition.findUniqueOrThrow({ where: { id: ids.pendingDraft } })).status).toBe('DRAFT');

  const outreach = await company.post('/api/company/outreach', { data: { menteeId: ids.mentee, message: 'Hello there, we would like to talk.' } });
  expect(outreach.status()).toBe(403);
  expect((await outreach.json()).code).toBe('company_not_verified');
});

test('a COMPANY user edits its own six fields, never quota, name or verification, never another company', async () => {
  const ok = await company.put(`/api/companies/${ids.pending}`, { data: { description: 'We build robots.', industry: 'Robotics' } });
  expect(ok.status()).toBe(200);
  expect(await prisma.company.findUniqueOrThrow({ where: { id: ids.pending } })).toMatchObject({ description: 'We build robots.', industry: 'Robotics' });

  const refused = await company.put(`/api/companies/${ids.pending}`, { data: { description: 'x', quota: 999, verificationStatus: 'VERIFIED', orgId: 'elsewhere' } });
  expect(refused.status()).toBe(403);
  const body = await refused.json();
  expect(body.code).toBe('protected_fields');
  expect(body.fields).toEqual(['orgId', 'quota', 'verificationStatus']);
  expect(await prisma.company.findUniqueOrThrow({ where: { id: ids.pending } })).toMatchObject({ quota: 3, verificationStatus: 'PENDING', orgId: org.id, description: 'We build robots.' });

  expect((await company.put(`/api/companies/${ids.legacy}`, { data: { description: 'hijack' } })).status()).toBe(404);
  // The verification endpoint is the admin's.
  expect((await company.post(`/api/admin/companies/${ids.pending}/verification`, { data: { action: 'approve' } })).status()).toBe(403);
});

test('an admin approves it: audited, the company told, its roles appear', { tag: '@smoke' }, async () => {
  const reject = await admin.post(`/api/admin/companies/${ids.pending}/verification`, { data: { action: 'reject' } });
  expect(reject.status()).toBe(400);
  expect((await reject.json()).code).toBe('reason_required');

  const queue = await admin.get('/api/companies?verification=PENDING&pageSize=50');
  expect((await queue.json()).companies.map((c: { id: string }) => c.id)).toEqual([ids.pending]);

  const approve = await admin.post(`/api/admin/companies/${ids.pending}/verification`, { data: { action: 'approve' } });
  expect(approve.status()).toBe(200);
  expect(await prisma.company.findUniqueOrThrow({ where: { id: ids.pending } })).toMatchObject({ verificationStatus: 'VERIFIED', verifiedById: ids.admin });
  expect(await prisma.auditLog.count({ where: { action: 'COMPANY_VERIFICATION', targetId: ids.pending, orgId: org.id } })).toBe(1);
  expect(await prisma.notification.count({ where: { userId: ids.companyUser, type: 'company.verification.approved' } })).toBe(1);

  const after = await board();
  expect(after.ids).toEqual(expect.arrayContaining([ids.legacyOpen, ids.pendingOpen]));
  expect(after.total).toBe(2);

  // Approving twice is not a move.
  expect((await admin.post(`/api/admin/companies/${ids.pending}/verification`, { data: { action: 'approve' } })).status()).toBe(400);

  // Suspending takes it off the board again, with the reason told.
  expect((await admin.post(`/api/admin/companies/${ids.pending}/verification`, { data: { action: 'suspend', reason: 'Spam postings' } })).status()).toBe(200);
  expect((await board()).ids).not.toContain(ids.pendingOpen);
  const note = await prisma.notification.findFirst({ where: { userId: ids.companyUser, type: 'company.verification.suspended' } });
  expect(note?.params).toMatchObject({ reason: 'Spam postings' });
});
