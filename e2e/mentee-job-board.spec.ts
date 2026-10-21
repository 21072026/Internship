import { test, expect, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';

// The mentee job board (#1830): only OPEN roles with a free seat, from the
// mentee's own org, with only the fields the card renders; search and filters
// narrow on the server and the total follows them; a company or a mentor is
// refused at the route; anything not visible is a 404 on the detail.

const PW = 'JobBoard123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const emails = { mentee: uniqueEmail('jobs-mentee'), company: uniqueEmail('jobs-company'), mentor: uniqueEmail('jobs-mentor') };
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
  await prisma.user.create({ data: { email: emails.mentee, password: hash, role: 'MENTEE', orgId: org.id, fullName: 'Job Seeker', skills: [] } });
  await prisma.user.create({ data: { email: emails.mentor, password: hash, role: 'MENTOR', orgId: org.id, fullName: 'Job Mentor', skills: [], mentorOnboardingSeenAt: new Date() } });
  const req = (key: string, data: Record<string, unknown>) =>
    prisma.requisition.create({ data: { orgId: org.id, companyId: acme.id, title: `${key} role ${stamp}`, openings: 2, requiredSkills: [], ownerId: owner.id, ...data }, select: { id: true } }).then((r) => { ids[key] = r.id; });
  await req('open', { status: 'OPEN', city: 'Berlin', workMode: 'Hybrid', requiredSkills: ['React', 'TypeScript'], startDate: new Date('2027-03-01T00:00:00Z'), description: 'Build the dashboard.' });
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
