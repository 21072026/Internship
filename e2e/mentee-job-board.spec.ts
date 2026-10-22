import { test, expect, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';

// The mentee job board (#1830): only OPEN roles with a free seat, from the
// mentee's own org, with only the fields the card renders; search and filters
// narrow on the server and the total follows them; a company or a mentor is
// refused at the route; anything not visible is a 404 on the detail.
// The apply flow (#1832): screening answers checked on the server, a second
// application refused by the unique key, a withdraw that cannot be undone, and
// the mentor told.

const PW = 'JobBoard123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const emails = { mentee: uniqueEmail('jobs-mentee'), company: uniqueEmail('jobs-company'), mentor: uniqueEmail('jobs-mentor') };
const users: Record<string, string> = {};
let org: { id: string };
let otherOrg: { id: string };
const ids: Record<string, string> = {};
let mentee: APIRequestContext;
let company: APIRequestContext;
let mentor: APIRequestContext;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  const hash = await bcrypt.hash(PW, 10);
  org = await prisma.organization.create({ data: { name: `Jobs Org ${stamp}`, slug: `jobs-${stamp}` }, select: { id: true } });
  otherOrg = await prisma.organization.create({ data: { name: `Jobs Other ${stamp}`, slug: `jobs-other-${stamp}` }, select: { id: true } });
  const acme = await prisma.company.create({ data: { name: `Acme Robotics ${stamp}`, orgId: org.id, description: 'We build robots.' }, select: { id: true } });
  const globex = await prisma.company.create({ data: { name: `Globex Data ${stamp}`, orgId: org.id }, select: { id: true } });
  const foreign = await prisma.company.create({ data: { name: `Foreign Co ${stamp}`, orgId: otherOrg.id }, select: { id: true } });
  const owner = await prisma.user.create({ data: { email: emails.company, password: hash, role: 'COMPANY', orgId: org.id, companyId: acme.id, fullName: 'Acme HR', skills: [] }, select: { id: true } });
  users.mentee = (await prisma.user.create({ data: { email: emails.mentee, password: hash, role: 'MENTEE', orgId: org.id, fullName: 'Job Seeker', skills: [] }, select: { id: true } })).id;
  users.mentor = (await prisma.user.create({ data: { email: emails.mentor, password: hash, role: 'MENTOR', orgId: org.id, fullName: 'Job Mentor', skills: [], mentorOnboardingSeenAt: new Date() }, select: { id: true } })).id;
  users.owner = owner.id;
  await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: users.mentor, menteeId: users.mentee, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' } });
  const req = (key: string, data: Record<string, unknown>) =>
    prisma.requisition.create({ data: { orgId: org.id, companyId: acme.id, title: `${key} role ${stamp}`, openings: 2, requiredSkills: [], ownerId: owner.id, ...data }, select: { id: true } }).then((r) => { ids[key] = r.id; });
  await req('open', {
    status: 'OPEN', city: 'Berlin', workMode: 'Hybrid', requiredSkills: ['React', 'TypeScript'], startDate: new Date('2027-03-01T00:00:00Z'), description: 'Build the dashboard.',
    screeningQuestions: [
      { id: 'permit', type: 'BOOLEAN', label: { en: 'Do you hold an EU work permit?', tr: 'AB çalışma iznin var mı?', de: 'Hast du eine EU-Arbeitserlaubnis?' }, required: true },
      { id: 'start', type: 'SELECT', label: { en: 'When can you start?', tr: 'Ne zaman başlayabilirsin?', de: 'Wann kannst du anfangen?' }, options: ['Now', 'Later'], required: false },
    ],
  });
  await req('globex', { status: 'OPEN', companyId: globex.id, city: 'Hamburg', workMode: 'Remote', requiredSkills: ['SQL'], ownerId: null });
  await req('draft', { status: 'DRAFT' });
  await req('hold', { status: 'ON_HOLD' });
  await req('cancelled', { status: 'CANCELLED' });
  await req('filledStatus', { status: 'FILLED', filled: 2 });
  await req('full', { status: 'OPEN', openings: 1, filled: 1 });
  ids.foreign = (await prisma.requisition.create({ data: { orgId: otherOrg.id, companyId: foreign.id, title: `foreign role ${stamp}`, status: 'OPEN', openings: 1, requiredSkills: [] }, select: { id: true } })).id;

  const baseURL = info.project.use.baseURL;
  [mentee, company, mentor] = await Promise.all([1, 2, 3].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(mentee, emails.mentee, PW)).ok).toBe(true);
  expect((await signInViaApi(company, emails.company, PW)).ok).toBe(true);
  expect((await signInViaApi(mentor, emails.mentor, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([mentee, company, mentor].map((c) => c?.dispose()));
  await prisma.notification.deleteMany({ where: { userId: { in: Object.values(users) } } }).catch(() => {});
  await prisma.application.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { orgId: { in: [org?.id, otherOrg?.id].filter(Boolean) } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: { in: [org?.id, otherOrg?.id].filter(Boolean) } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: [org?.id, otherOrg?.id].filter(Boolean) } } }).catch(() => {});
});

test('a mentee sees only open roles with a free seat, from their own org, with only the card\'s fields', { tag: '@smoke' }, async () => {
  const res = await mentee.get('/api/portal/requisitions');
  expect(res.status()).toBe(200);
  const body = await res.json();
  const listed = (body.jobs as { id: string }[]).map((j) => j.id).sort();
  expect(listed).toEqual([ids.open, ids.globex].sort());
  expect(body.total).toBe(2);
  const card = (body.jobs as Record<string, unknown>[]).find((j) => j.id === ids.open)!;
  expect(Object.keys(card).sort()).toEqual(['city', 'company', 'description', 'filled', 'id', 'openings', 'requiredSkills', 'startDate', 'title', 'workMode']);
  expect(JSON.stringify(body)).not.toContain('screeningQuestions');
  expect(JSON.stringify(body)).not.toContain('ownerId');
  // The detail follows the same rule: not visible is a 404, never a 403.
  expect((await mentee.get(`/api/portal/requisitions/${ids.open}`)).status()).toBe(200);
  for (const hidden of [ids.draft, ids.hold, ids.cancelled, ids.filledStatus, ids.full, ids.foreign, 'nope']) {
    expect((await mentee.get(`/api/portal/requisitions/${hidden}`)).status(), hidden).toBe(404);
  }
  // Not a door for a company or a mentor.
  expect((await company.get('/api/portal/requisitions')).status()).toBe(403);
  expect((await company.get(`/api/portal/requisitions/${ids.open}`)).status()).toBe(403);
  expect((await mentor.get('/api/portal/requisitions')).status()).toBe(403);
});

test('search and filters narrow on the server, and the total follows them', async () => {
  const total = async (qs: string) => (await (await mentee.get(`/api/portal/requisitions?${qs}`)).json()).total;
  expect(await total(`q=${encodeURIComponent('Globex')}`)).toBe(1); // by company name
  expect(await total(`q=${encodeURIComponent(`open role ${stamp}`)}`)).toBe(1); // by title
  expect(await total('city=berlin')).toBe(1);
  expect(await total('workMode=remote')).toBe(1);
  expect(await total('skill=typescr')).toBe(1);
  expect(await total('skill=cobol')).toBe(0);
  const paged = await (await mentee.get('/api/portal/requisitions?pageSize=1&page=2')).json();
  expect(paged.jobs).toHaveLength(1);
  expect(paged.total).toBe(2);
});

test('the portal shows Jobs in the sidebar, lists the open role, never the draft, and opens the detail', async ({ page }) => {
  await signInAsFreshUser(page, emails.mentee, PW, '/portal');
  await gotoSettled(page, '/portal/jobs');
  await expect(page.locator('a[href="/portal/jobs"]').first()).toBeVisible();
  await expect(page.getByTestId(`job-card-${ids.open}`)).toBeVisible();
  await expect(page.getByTestId(`job-card-${ids.draft}`)).toHaveCount(0);
  await expect(page.getByTestId('portal-jobs-count')).toContainText('2');
  await page.getByTestId('portal-jobs-search').fill('Globex');
  await page.getByTestId('portal-jobs-apply').click();
  await expect(page.getByTestId(`job-card-${ids.open}`)).toHaveCount(0);
  await expect(page.getByTestId(`job-card-${ids.globex}`)).toBeVisible();

  await gotoSettled(page, `/portal/jobs/${ids.open}`);
  await expect(page.getByTestId('portal-job-detail')).toContainText('Build the dashboard.');
  await expect(page.getByTestId('portal-job-detail')).toContainText('We build robots.');
  await gotoSettled(page, `/portal/jobs/${ids.draft}`);
  await expect(page.getByTestId('portal-job-not-found')).toBeVisible();
});

test('apply checks the answers on the server, a second application is a 409, and withdraw is final', { tag: '@smoke' }, async () => {
  const blank = await mentee.post('/api/applications', { data: { requisitionId: ids.open, screeningAnswers: {} } });
  expect(blank.status()).toBe(400);
  expect((await blank.json()).code).toBe('required_missing');
  expect((await mentee.post('/api/applications', { data: { requisitionId: ids.open, screeningAnswers: { permit: true, salary: 'x' } } })).status()).toBe(400);
  // Not on the board, not appliable: a draft, a full role, another org's.
  for (const hidden of [ids.draft, ids.full, ids.foreign]) {
    expect((await mentee.post('/api/applications', { data: { requisitionId: hidden } })).status(), hidden).toBe(404);
  }
  // Only a mentee applies.
  expect((await company.post('/api/applications', { data: { requisitionId: ids.open, screeningAnswers: { permit: true } } })).status()).toBe(403);

  const ok = await mentee.post('/api/applications', { data: { requisitionId: ids.open, coverNote: 'I love dashboards.', screeningAnswers: { permit: true, start: 'Now' } } });
  expect(ok.status()).toBe(201);
  const app = (await ok.json()).application;
  expect(app).toMatchObject({ stage: 'APPLIED', status: 'ACTIVE', source: 'SELF' });
  const row = await prisma.application.findUniqueOrThrow({ where: { id: app.id }, include: { events: true } });
  expect(row.screeningAnswers).toEqual({ permit: true, start: 'Now' });
  expect(row.coverNote).toBe('I love dashboards.');
  expect(row.events).toHaveLength(1);
  expect(row.events[0]).toMatchObject({ fromStage: null, toStage: 'APPLIED', actorId: users.mentee });

  const dup = await mentee.post('/api/applications', { data: { requisitionId: ids.open, screeningAnswers: { permit: true } } });
  expect(dup.status()).toBe(409);
  expect((await dup.json()).code).toBe('already_applied');
  expect(await prisma.application.count({ where: { requisitionId: ids.open, menteeId: users.mentee } })).toBe(1);

  // The company and the mentor are told; the mentee sees it in their own list, scoped server-side.
  expect(await prisma.notification.count({ where: { userId: users.owner, type: 'job_application.received' } })).toBe(1);
  expect(await prisma.notification.count({ where: { userId: users.mentor, type: 'job_application.mentee_applied' } })).toBe(1);
  const mine = (await (await mentee.get('/api/applications')).json()).applications as { id: string }[];
  expect(mine.map((a) => a.id)).toEqual([app.id]);
  expect(((await (await company.get('/api/applications')).json()).applications as { id: string }[]).map((a) => a.id)).toContain(app.id);
  expect((await (await mentee.get(`/api/portal/requisitions/${ids.open}`)).json()).myApplication).toMatchObject({ id: app.id, stage: 'APPLIED' });

  // Withdraw: one event, withdrawnAt stamped, and no way back.
  expect((await company.patch(`/api/applications/${app.id}`, { data: { action: 'withdraw' } })).status()).toBe(409);
  const withdrawn = await mentee.patch(`/api/applications/${app.id}`, { data: { action: 'withdraw' } });
  expect(withdrawn.status()).toBe(200);
  expect((await withdrawn.json()).application).toMatchObject({ stage: 'WITHDRAWN', status: 'WITHDRAWN' });
  const after = await prisma.application.findUniqueOrThrow({ where: { id: app.id }, include: { events: true } });
  expect(after.withdrawnAt).not.toBeNull();
  expect(after.events).toHaveLength(2);
  expect((await mentee.patch(`/api/applications/${app.id}`, { data: { action: 'withdraw' } })).status()).toBe(409);
  expect((await mentee.patch(`/api/applications/${app.id}/stage`, { data: { toStage: 'APPLIED', expectedStage: 'WITHDRAWN' } })).status()).toBe(400);
});

test('the apply form and the applications list work in the portal', async ({ page }) => {
  await signInAsFreshUser(page, emails.mentee, PW, '/portal');
  await gotoSettled(page, `/portal/jobs/${ids.globex}`);
  await page.getByTestId('portal-job-cover-note').fill('Data is my thing.');
  await page.getByTestId('portal-job-apply-submit').click();
  await expect(page.getByTestId('portal-job-applied')).toBeVisible();
  const app = await prisma.application.findUniqueOrThrow({ where: { requisitionId_menteeId: { requisitionId: ids.globex, menteeId: users.mentee } } });

  await gotoSettled(page, '/portal/applications');
  await expect(page.getByTestId(`application-row-${app.id}`)).toBeVisible();
  await expect(page.getByTestId(`application-stage-${app.id}`)).toHaveText('Applied');
  await page.getByTestId(`application-withdraw-${app.id}`).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByTestId(`application-stage-${app.id}`)).toHaveText('Withdrawn');
  await expect(page.getByTestId(`application-withdraw-${app.id}`)).toHaveCount(0);
});
