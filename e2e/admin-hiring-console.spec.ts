import { test, expect, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { statusForStage, type ApplicationStage } from '../src/lib/applications';

// The hiring desk (#1874): four bounded queues of things waiting on the
// programme owner, plus header numbers, all computed from one tenant's rows.
// Each fixture row below has a twin that must NOT appear — a decided request,
// a recently-moved or terminal application, an offer outside the window, a
// role that is full or has someone in its funnel — so a count that is right
// for the wrong reason fails.

const PW = 'HiringDesk123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);
const emails = {
  admin: uniqueEmail('hiring-admin'),
  emptyAdmin: uniqueEmail('hiring-empty-admin'),
  company: uniqueEmail('hiring-company'),
  mentor: uniqueEmail('hiring-mentor'),
  m1: uniqueEmail('hiring-m1'),
  m2: uniqueEmail('hiring-m2'),
  m3: uniqueEmail('hiring-m3'),
};
let org: { id: string };
let emptyOrg: { id: string };
let company: { id: string };
const u: Record<string, { id: string }> = {};
const ids: Record<string, string> = {};
let adminCtx: APIRequestContext;
let companyCtx: APIRequestContext;
let mentorCtx: APIRequestContext;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  const hash = await bcrypt.hash(PW, 10);
  org = await prisma.organization.create({ data: { name: `Hiring Org ${stamp}`, slug: `hiring-${stamp}` }, select: { id: true } });
  emptyOrg = await prisma.organization.create({ data: { name: `Hiring Empty ${stamp}`, slug: `hiring-empty-${stamp}` }, select: { id: true } });
  company = await prisma.company.create({ data: { name: `Hiring Co ${stamp}`, orgId: org.id }, select: { id: true } });
  const mk = (email: string, role: 'ADMIN' | 'COMPANY' | 'MENTOR' | 'MENTEE', orgId = org.id, extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email, password: hash, role, orgId, fullName: `${email.split('@')[0]}`, skills: [], ...extra }, select: { id: true } });
  u.admin = await mk(emails.admin, 'ADMIN');
  u.emptyAdmin = await mk(emails.emptyAdmin, 'ADMIN', emptyOrg.id);
  u.company = await mk(emails.company, 'COMPANY', org.id, { companyId: company.id });
  u.mentor = await mk(emails.mentor, 'MENTOR', org.id, { mentorOnboardingSeenAt: new Date() });
  for (const k of ['m1', 'm2', 'm3'] as const) u[k] = await mk(emails[k], 'MENTEE');
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId: org.id, companyId: company.id, mentorId: u.mentor.id, menteeId: u.m1.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
    select: { id: true },
  });
  ids.relation = relation.id;

  const req = (title: string, status: string, openings: number, filled = 0, createdAt = ago(3)) =>
    prisma.requisition.create({ data: { orgId: org.id, companyId: company.id, title: `${title} ${stamp}`, status, openings, filled, requiredSkills: [], createdAt }, select: { id: true } });
  ids.reqBusy = (await req('Busy role', 'OPEN', 2)).id;
  ids.reqEmpty = (await req('Empty role', 'OPEN', 2, 0, ago(9))).id;
  ids.reqFull = (await req('Full role', 'OPEN', 1, 1)).id;
  ids.reqDraft = (await req('Draft role', 'DRAFT', 1)).id;

  const app = async (menteeKey: string, requisitionId: string, stage: ApplicationStage, createdAt: Date, lastEvent: Date | null, decidedAt?: Date) => {
    const row = await prisma.application.create({
      data: {
        orgId: org.id, requisitionId, menteeId: u[menteeKey].id, companyId: company.id, stage, status: statusForStage(stage), createdAt,
        ...(decidedAt ? { decidedAt } : {}),
        events: { create: [{ fromStage: null, toStage: 'APPLIED', createdAt }, ...(lastEvent ? [{ fromStage: 'APPLIED', toStage: stage, createdAt: lastEvent }] : [])] },
      },
      select: { id: true },
    });
    return row.id;
  };
  ids.stalled = await app('m1', ids.reqBusy, 'SCREENING', ago(30), ago(20));
  ids.fresh = await app('m2', ids.reqBusy, 'SCREENING', ago(30), ago(2));
  ids.rejectedOld = await app('m3', ids.reqBusy, 'REJECTED', ago(40), ago(35), ago(35));
  ids.hired = await app('m3', ids.reqFull, 'HIRED', ago(40), ago(1), new Date());

  ids.irPending = (await prisma.interviewRequest.create({ data: { orgId: org.id, companyId: company.id, requisitionId: ids.reqBusy, menteeId: u.m1.id, status: 'PENDING', createdAt: ago(5) }, select: { id: true } })).id;
  ids.irApproved = (await prisma.interviewRequest.create({ data: { orgId: org.id, companyId: company.id, requisitionId: ids.reqBusy, menteeId: u.m2.id, status: 'APPROVED' }, select: { id: true } })).id;

  const offer = (status: string, extra: Record<string, unknown>) =>
    prisma.offer.create({ data: { orgId: org.id, relationId: relation.id, companyId: company.id, createdById: u.admin.id, position: `Engineer ${status}`, status, ...extra }, select: { id: true } });
  ids.offerSoon = (await offer('SENT', { sentAt: ago(1), expiresAt: ahead(3) })).id;
  ids.offerLater = (await offer('SENT', { sentAt: ago(1), expiresAt: ahead(10) })).id;
  await offer('ACCEPTED', { decidedAt: ago(10) });
  await offer('DECLINED', { decidedAt: ago(20) });
  await offer('ACCEPTED', { decidedAt: ago(200) }); // outside the 90-day window
  await offer('WITHDRAWN', { decidedAt: ago(5) }); // the programme's own decision: counts on neither side

  const baseURL = info.project.use.baseURL;
  [adminCtx, companyCtx, mentorCtx] = await Promise.all([1, 2, 3].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(adminCtx, emails.admin, PW)).ok).toBe(true);
  expect((await signInViaApi(companyCtx, emails.company, PW)).ok).toBe(true);
  expect((await signInViaApi(mentorCtx, emails.mentor, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([adminCtx, companyCtx, mentorCtx].map((c) => c?.dispose()));
  await prisma.offer.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.interviewRequest.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.application.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: [org?.id, emptyOrg?.id].filter(Boolean) } } }).catch(() => {});
});

test('only an ADMIN reaches the hiring desk', { tag: '@smoke' }, async ({ playwright }, info) => {
  expect((await companyCtx.get('/api/admin/hiring/queues')).status()).toBe(403);
  expect((await mentorCtx.get('/api/admin/hiring/queues')).status()).toBe(403);
  expect((await mentorCtx.get('/api/admin/hiring/queues?summary=1')).status()).toBe(403);
  const anon = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await anon.get('/api/admin/hiring/queues')).status()).toBe(401);
  await anon.dispose();
});

test('the four queues hold exactly what is waiting, and the header counts the tenant', async () => {
  const res = await adminCtx.get('/api/admin/hiring/queues');
  expect(res.status()).toBe(200);
  const body = await res.json();
  const idsOf = (q: string) => (body.queues[q].items as { id: string }[]).map((r) => r.id);

  expect(body.queues.awaitingDecision.total).toBe(1);
  expect(idsOf('awaitingDecision')).toEqual([ids.irPending]);
  expect(body.queues.awaitingDecision.items[0]).toMatchObject({ daysWaiting: 5, href: '/admin/interview-requests' });

  // The clock is the latest event: 20 days since the last move is stalled, 2 days is not; a terminal stage never is.
  expect(body.stallDays).toBe(14);
  expect(body.queues.stalledApplications.total).toBe(1);
  expect(idsOf('stalledApplications')).toEqual([ids.stalled]);
  expect(body.queues.stalledApplications.items[0]).toMatchObject({ stage: 'SCREENING', daysWaiting: 20, href: `/admin/candidates/${u.m1.id}` });

  expect(body.queues.offersExpiring.total).toBe(1);
  expect(idsOf('offersExpiring')).toEqual([ids.offerSoon]);
  expect(body.queues.offersExpiring.items[0].href).toBe('/admin/offers?status=SENT&expiringWithinDays=7');

  // Open with a seat left and nobody open in the funnel — not the busy one, not the full one, not the draft.
  expect(body.queues.emptyRoles.total).toBe(1);
  expect(idsOf('emptyRoles')).toEqual([ids.reqEmpty]);
  expect(body.queues.emptyRoles.items[0]).toMatchObject({ openings: 2, filled: 0, daysWaiting: 9 });

  expect(body.header).toEqual({ openRoles: 3, hiresThisMonth: 1, offersOutstanding: 2, acceptanceRate: 50 });

  // The sidebar badge: the two actionable queues.
  expect(await (await adminCtx.get('/api/admin/hiring/queues?summary=1')).json()).toEqual({ actionable: 2 });
});

test('the stall threshold is a setting', async () => {
  await prisma.setting.create({ data: { orgId: org.id, key: 'hiringStallDays', value: '1' } });
  try {
    const body = await (await adminCtx.get('/api/admin/hiring/queues')).json();
    expect(body.stallDays).toBe(1);
    expect((body.queues.stalledApplications.items as { id: string }[]).map((r) => r.id).sort()).toEqual([ids.stalled, ids.fresh].sort());
  } finally {
    await prisma.setting.deleteMany({ where: { orgId: org.id, key: 'hiringStallDays' } });
  }
});

test('the page shows each queue with its rows and links, and an empty tenant gets explicit empty states', async ({ page }) => {
  await signInAsFreshUser(page, emails.admin, PW, '/admin');
  await gotoSettled(page, '/admin/hiring');
  await expect(page.getByTestId('hiring-header-openRoles')).toHaveText('3');
  await expect(page.getByTestId('hiring-header-acceptanceRate')).toHaveText('50 %');
  for (const [queue, id] of [
    ['awaitingDecision', ids.irPending], ['stalledApplications', ids.stalled], ['offersExpiring', ids.offerSoon], ['emptyRoles', ids.reqEmpty],
  ] as const) {
    await expect(page.getByTestId(`hiring-queue-${queue}-count`)).toHaveText('1');
    await expect(page.getByTestId(`hiring-queue-${queue}-row-${id}`)).toBeVisible();
  }
  await expect(page.getByTestId(`hiring-queue-stalledApplications-row-${ids.stalled}`).locator('a')).toHaveAttribute('href', `/admin/candidates/${u.m1.id}`);
  await expect(page.getByTestId('admin-hiring-badge')).toHaveText('2');
  const axe = await new AxeBuilder({ page }).include('[data-testid="admin-hiring"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  await signInAsFreshUser(page, emails.emptyAdmin, PW, '/admin');
  await gotoSettled(page, '/admin/hiring');
  for (const queue of ['awaitingDecision', 'stalledApplications', 'offersExpiring', 'emptyRoles']) {
    await expect(page.getByTestId(`hiring-queue-${queue}-empty`)).toBeVisible();
    await expect(page.getByTestId(`hiring-queue-${queue}-count`)).toHaveText('0');
  }
  await expect(page.getByTestId('hiring-header-acceptanceRate')).toHaveText('No data yet');
  await expect(page.getByTestId('page-loading')).toHaveCount(0);
});
