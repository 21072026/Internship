import { test, expect, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { statusForStage, type ApplicationStage } from '../src/lib/applications';

// Employer recruiting analytics (#1911): the date range changes the numbers and
// a malformed one falls back instead of failing; a company reads only its own
// company; time-to-fill counts filled seats only; the benchmark is a 403
// without the entitlement and, with it, aggregates behind the anonymity floors.

const PW = 'Recruiting123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const ymd = (date: Date) => date.toISOString().slice(0, 10);
const emails = { a: uniqueEmail('recr-company-a'), b: uniqueEmail('recr-company-b'), admin: uniqueEmail('recr-admin') };
let org: { id: string };
let companyA: { id: string };
let companyB: { id: string };
const peers: { id: string }[] = [];
let reqA: { id: string };
let reqB: { id: string };
let ctxA: APIRequestContext;
let ctxB: APIRequestContext;
let mentee: { id: string };
const extraMentees: string[] = [];

test.describe.configure({ mode: 'serial' });

async function mkApp(companyId: string, requisitionId: string, menteeId: string, stage: ApplicationStage, createdAt: Date, source = 'SELF') {
  return prisma.application.create({
    data: {
      orgId: org.id, companyId, requisitionId, menteeId, stage, status: statusForStage(stage), source, createdAt,
      events: { create: [{ fromStage: null, toStage: 'APPLIED', createdAt }, ...(stage !== 'APPLIED' ? [{ fromStage: 'APPLIED', toStage: stage, createdAt: new Date(createdAt.getTime() + 2 * DAY) }] : [])] },
    },
  });
}

test.beforeAll(async ({ playwright }, info) => {
  const hash = await bcrypt.hash(PW, 10);
  org = await prisma.organization.create({ data: { name: `Recr Org ${stamp}`, slug: `recr-${stamp}` }, select: { id: true } });
  companyA = await prisma.company.create({ data: { name: `Recr A ${stamp}`, orgId: org.id }, select: { id: true } });
  companyB = await prisma.company.create({ data: { name: `Recr B ${stamp}`, orgId: org.id }, select: { id: true } });
  for (const email of [emails.a, emails.b]) {
    await prisma.user.create({ data: { email, password: hash, role: 'COMPANY', orgId: org.id, companyId: email === emails.a ? companyA.id : companyB.id, fullName: 'Recruiter', skills: [] } });
  }
  const admin = await prisma.user.create({ data: { email: emails.admin, password: hash, role: 'ADMIN', orgId: org.id, fullName: 'Recr Admin', skills: [] }, select: { id: true } });
  mentee = await prisma.user.create({ data: { email: uniqueEmail('recr-mentee'), password: hash, role: 'MENTEE', orgId: org.id, fullName: 'Recr Mentee', skills: [] }, select: { id: true } });
  const mentor = await prisma.user.create({ data: { email: uniqueEmail('recr-mentor'), password: hash, role: 'MENTOR', orgId: org.id, fullName: 'Recr Mentor', skills: [] }, select: { id: true } });
  extraMentees.push(mentee.id, mentor.id);
  reqA = await prisma.requisition.create({ data: { orgId: org.id, companyId: companyA.id, title: `Recr Role A ${stamp}`, status: 'OPEN', openings: 3, requiredSkills: [], createdAt: daysAgo(60) }, select: { id: true } });
  reqB = await prisma.requisition.create({ data: { orgId: org.id, companyId: companyB.id, title: `Recr Role B ${stamp}`, status: 'OPEN', openings: 1, requiredSkills: [], createdAt: daysAgo(60) }, select: { id: true } });
  // A second role of A that never fills: it is considered, never counted as zero days.
  await prisma.requisition.create({ data: { orgId: org.id, companyId: companyA.id, title: `Recr Role A2 ${stamp}`, status: 'OPEN', openings: 1, requiredSkills: [], createdAt: daysAgo(30) } });

  // Company A: 6 applications — 5 recent (one hired), 1 from 200 days ago outside the default window.
  const people: string[] = [];
  for (let i = 0; i < 6; i++) {
    const p = await prisma.user.create({ data: { email: uniqueEmail(`recr-cand-${i}`), password: hash, role: 'MENTEE', orgId: org.id, fullName: `Cand ${i}`, skills: [] }, select: { id: true } });
    people.push(p.id); extraMentees.push(p.id);
  }
  await mkApp(companyA.id, reqA.id, people[0], 'HIRED', daysAgo(40));
  await mkApp(companyA.id, reqA.id, people[1], 'INTERVIEW', daysAgo(20), 'SHORTLIST');
  await mkApp(companyA.id, reqA.id, people[2], 'REJECTED', daysAgo(15));
  await mkApp(companyA.id, reqA.id, people[3], 'APPLIED', daysAgo(10));
  await mkApp(companyA.id, reqA.id, people[4], 'SCREENING', daysAgo(5));
  await mkApp(companyA.id, reqA.id, people[5], 'APPLIED', daysAgo(200));
  // B's one application — must never show up in A's numbers.
  await mkApp(companyB.id, reqB.id, mentee.id, 'APPLIED', daysAgo(3));

  // The seat A filled: an accepted offer took it 25 days after the role opened.
  const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: people[0], companyId: companyA.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' }, select: { id: true } });
  await prisma.offer.create({ data: { orgId: org.id, relationId: relation.id, companyId: companyA.id, requisitionId: reqA.id, createdById: admin.id, position: 'Engineer', status: 'ACCEPTED', decidedAt: daysAgo(35), requisitionCountedAt: daysAgo(35) } });

  // Three peer employers with ≥5 applications each, so the pool opens (MIN_OTHER_PROGRAMS = 3).
  for (let c = 0; c < 3; c++) {
    const peer = await prisma.company.create({ data: { name: `Recr Peer ${c} ${stamp}`, orgId: org.id }, select: { id: true } });
    peers.push(peer);
    const role = await prisma.requisition.create({ data: { orgId: org.id, companyId: peer.id, title: `Peer role ${c}`, status: 'OPEN', openings: 1, requiredSkills: [] }, select: { id: true } });
    for (let i = 0; i < 5; i++) await mkApp(peer.id, role.id, people[i], i === 0 && c === 0 ? 'HIRED' : 'APPLIED', daysAgo(12));
  }

  const baseURL = info.project.use.baseURL;
  [ctxA, ctxB] = await Promise.all([1, 2].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(ctxA, emails.a, PW)).ok).toBe(true);
  expect((await signInViaApi(ctxB, emails.b, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([ctxA, ctxB].map((c) => c?.dispose()));
  await prisma.offer.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.application.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.companyEntitlement.deleteMany({ where: { companyId: companyA?.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { OR: [{ email: { in: Object.values(emails) } }, { id: { in: extraMentees } }] } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: org?.id } }).catch(() => {});
});

test('a company reads only its own recruiting numbers; another company\'s role is a 404', { tag: '@smoke' }, async () => {
  const a = (await (await ctxA.get('/api/company/analytics')).json()).recruiting;
  expect(a.applications).toBe(5); // the 200-day-old one is outside the default window
  const b = (await (await ctxB.get('/api/company/analytics')).json()).recruiting;
  expect(b.applications).toBe(1);
  // B cannot narrow onto A's role — and is not told it exists.
  expect((await ctxB.get(`/api/company/analytics?requisitionId=${reqA.id}`)).status()).toBe(404);
  // The benchmark without the entitlement is refused, not emptied.
  const locked = await ctxA.get('/api/company/analytics/benchmark');
  expect(locked.status()).toBe(403);
  expect((await locked.json()).code).toBe('feature_locked');
});

test('the window changes the numbers, a bad one falls back, and time-to-fill counts filled seats only', async () => {
  const wide = (await (await ctxA.get(`/api/company/analytics?from=${ymd(daysAgo(365))}&to=${ymd(new Date())}`)).json()).recruiting;
  expect(wide.applications).toBe(6);
  const narrow = (await (await ctxA.get(`/api/company/analytics?from=${ymd(daysAgo(12))}&to=${ymd(new Date())}`)).json()).recruiting;
  expect(narrow.applications).toBe(2);
  const bad = await ctxA.get('/api/company/analytics?from=garbage&to=also-garbage');
  expect(bad.status()).toBe(200);
  expect((await bad.json()).recruiting.applications).toBe(5);
  const inverted = await ctxA.get(`/api/company/analytics?from=${ymd(new Date())}&to=${ymd(daysAgo(30))}`);
  expect(inverted.status()).toBe(200);

  const r = (await (await ctxA.get('/api/company/analytics')).json()).recruiting;
  // Two roles open in the window, one seat filled 25 days after its role opened; the unfilled role is not a zero.
  expect(r.timeToFill).toMatchObject({ filled: 1, considered: 2, medianDays: 25 });
  expect(r.funnel.timeToHire).toMatchObject({ completed: 1, considered: 5 });
  expect(r.sources.find((s: { source: string }) => s.source === 'SHORTLIST')).toMatchObject({ applications: 1, hired: 0 });
  expect(r.funnel.stages.find((s: { key: string }) => s.key === 'APPLIED')).toMatchObject({ entered: 5 });
  // Narrowed to the role, the same numbers (all of A's applications are on it).
  expect((await (await ctxA.get(`/api/company/analytics?requisitionId=${reqA.id}`)).json()).recruiting.applications).toBe(5);
});

test('with the entitlement the benchmark returns aggregates only, behind the floors', async () => {
  await prisma.companyEntitlement.create({ data: { companyId: companyA.id, feature: 'ADVANCED_ANALYTICS' } });
  const res = await ctxA.get('/api/company/analytics/benchmark');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.available).toBe(true);
  expect(body.you).toMatchObject({ total: 5, hired: 1, conversion: 20 });
  // Three peers at 20 %, 0 %, 0 % → 7 %; no name, no id, no per-employer row, not even the pool size.
  expect(body.avgConversion).toBe(7);
  const raw = JSON.stringify(body);
  for (const p of peers) expect(raw).not.toContain(p.id);
  expect(raw).not.toContain('Recr Peer');
  expect(body).not.toHaveProperty('poolSize');
  // A narrow window with too few peer applications closes the pool rather than exposing anyone.
  const thin = await (await ctxA.get(`/api/company/analytics/benchmark?from=${ymd(daysAgo(4))}&to=${ymd(new Date())}`)).json();
  expect(thin.available).toBe(false);
  expect(thin.avgConversion).toBeNull();
  expect(thin.percentile).toBeNull();
  // Company B, unentitled, still cannot read it.
  expect((await ctxB.get('/api/company/analytics/benchmark')).status()).toBe(403);
});

test('the company screen shows the report, with print, and export when the plan carries it', async ({ page }) => {
  await prisma.companyEntitlement.create({ data: { companyId: companyA.id, feature: 'REPORT_EXPORT' } });
  await signInAsFreshUser(page, emails.a, PW, '/company');
  await gotoSettled(page, '/company/analytics');
  await expect(page.getByTestId('recruiting-applications')).toContainText('5');
  await expect(page.getByTestId('recruiting-time-to-fill')).toContainText('25');
  await expect(page.getByTestId('recruiting-print')).toBeVisible();
  await expect(page.getByTestId('recruiting-export')).toBeVisible();
  await expect(page.getByTestId('recruiting-benchmark')).toContainText('7 %');
  const download = page.waitForEvent('download');
  await page.getByTestId('recruiting-export').click();
  expect((await download).suggestedFilename()).toMatch(/^recruiting-.*\.xlsx$/);
});
