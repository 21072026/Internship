import { test, expect, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { statusForStage, type ApplicationStage } from '../src/lib/applications';

// The applicant board of one requisition (#1838). An applicant who applied
// (source SELF — no company relation, no admin step) is on the owning
// company's board; the column counts are the server's groupBy over the same
// filter the rows come from; every filter narrows in SQL; one column pages on
// its own; another company's requisition is a 404; and the drawer carries no
// e-mail and no phone.

const PW = 'BoardPass123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const emails = {
  companyA: uniqueEmail('board-company-a'),
  companyB: uniqueEmail('board-company-b'),
  m1: uniqueEmail('board-m1'),
  m2: uniqueEmail('board-m2'),
  m3: uniqueEmail('board-m3'),
};
let org: { id: string };
let companyA: { id: string };
let companyB: { id: string };
let reqA: { id: string };
const users: Record<string, { id: string }> = {};
const apps: Record<string, string> = {};
let ctxA: APIRequestContext;
let ctxB: APIRequestContext;
let ctxMentee: APIRequestContext;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  const hash = await bcrypt.hash(PW, 10);
  org = await prisma.organization.create({ data: { name: `Board Org ${stamp}`, slug: `board-${stamp}` }, select: { id: true } });
  companyA = await prisma.company.create({ data: { name: `Board Co A ${stamp}`, orgId: org.id }, select: { id: true } });
  companyB = await prisma.company.create({ data: { name: `Board Co B ${stamp}`, orgId: org.id }, select: { id: true } });
  const mk = (email: string, role: 'COMPANY' | 'MENTEE', extra: Record<string, unknown> = {}) =>
    prisma.user.create({ data: { email, password: hash, role, orgId: org.id, fullName: email.split('@')[0], skills: [], ...extra }, select: { id: true } });
  users.companyA = await mk(emails.companyA, 'COMPANY', { companyId: companyA.id });
  users.companyB = await mk(emails.companyB, 'COMPANY', { companyId: companyB.id });
  users.m1 = await mk(emails.m1, 'MENTEE', { fullName: `Ada Board ${stamp}`, city: 'Berlin', skills: ['React', 'Figma'], phone: '+49 30 1234567' });
  users.m2 = await mk(emails.m2, 'MENTEE', { fullName: `Bo Board ${stamp}`, city: 'Hamburg', skills: ['Java'] });
  users.m3 = await mk(emails.m3, 'MENTEE', { fullName: `Cy Board ${stamp}`, city: 'Berlin', skills: ['sql'] });
  reqA = await prisma.requisition.create({
    data: { orgId: org.id, companyId: companyA.id, title: `Board Role ${stamp}`, status: 'OPEN', openings: 3, filled: 1, requiredSkills: ['React', 'SQL'] },
    select: { id: true },
  });
  const mkApp = async (key: string, stage: ApplicationStage, screeningAnswers?: Record<string, string | boolean>) => {
    const app = await prisma.application.create({
      data: { orgId: org.id, requisitionId: reqA.id, menteeId: users[key].id, companyId: companyA.id, stage, status: statusForStage(stage), source: 'SELF', ...(screeningAnswers ? { screeningAnswers } : {}) },
      select: { id: true },
    });
    apps[key] = app.id;
  };
  await mkApp('m1', 'APPLIED', { relocate: true, 'work-permit': 'EU' });
  await mkApp('m2', 'APPLIED', { relocate: false });
  await mkApp('m3', 'SCREENING');

  const baseURL = info.project.use.baseURL;
  [ctxA, ctxB, ctxMentee] = await Promise.all([1, 2, 3].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(ctxA, emails.companyA, PW)).ok).toBe(true);
  expect((await signInViaApi(ctxB, emails.companyB, PW)).ok).toBe(true);
  expect((await signInViaApi(ctxMentee, emails.m1, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([ctxA, ctxB, ctxMentee].map((c) => c?.dispose()));
  await prisma.application.deleteMany({ where: { requisitionId: reqA?.id } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { actorId: users.companyA?.id } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { orgId: org?.id } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: org?.id } }).catch(() => {});
});

const board = (ctx: APIRequestContext, qs = '') => ctx.get(`/api/company/requisitions/${reqA.id}/applications${qs ? `?${qs}` : ''}`);

test('a self-applied candidate is on the owning company\'s board, counted by stage, and only there', { tag: '@smoke' }, async () => {
  const res = await board(ctxA);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.requisition).toMatchObject({ id: reqA.id, openings: 3, filled: 1, status: 'OPEN' });
  expect(body.counts).toEqual({ APPLIED: 2, SCREENING: 1, SHORTLISTED: 0, INTERVIEW: 0, OFFER: 0, HIRED: 0, REJECTED: 0, WITHDRAWN: 0 });
  const applied = body.columns.APPLIED.items as { id: string; matchedSkills: string[]; answered: number; mentee: Record<string, unknown> }[];
  const ada = applied.find((c) => c.id === apps.m1)!;
  expect(ada.matchedSkills).toEqual(['React']);
  expect(ada.answered).toBe(2);
  expect(Object.keys(ada.mentee).sort()).toEqual(['city', 'fullName', 'id']);
  // Turkish-aware, case-insensitive skill match: "sql" meets "SQL".
  expect((body.columns.SCREENING.items as { id: string; matchedSkills: string[] }[])[0]).toMatchObject({ id: apps.m3, matchedSkills: ['sql'] });
  // Nothing on the board can reach a candidate directly.
  const raw = JSON.stringify(body);
  expect(raw).not.toContain(emails.m1);
  expect(raw).not.toContain('1234567');

  // Another company: not found, never "forbidden" (that would confirm the id).
  expect((await board(ctxB)).status()).toBe(404);
  expect((await ctxB.get('/api/company/requisitions/does-not-exist/applications')).status()).toBe(404);
  // Not a company at all.
  expect((await board(ctxMentee)).status()).toBe(403);
  // The drawer's source answers for an applicant with no company relation — and still without e-mail or phone.
  const detail = await ctxA.get(`/api/company/candidates/${users.m1.id}`);
  expect(detail.status()).toBe(200);
  const candidate = (await detail.json()).candidate;
  expect(candidate).not.toHaveProperty('email');
  expect(candidate).not.toHaveProperty('phone');
  expect(candidate.mentorName).toBeNull();
  expect((await ctxB.get(`/api/company/candidates/${users.m1.id}`)).status()).toBe(404);
});

test('filters narrow in SQL, counts follow them, and one column pages on its own', async () => {
  const count = async (qs: string) => (await (await board(ctxA, qs)).json()).counts;
  expect((await count('skill=reac')).APPLIED).toBe(1);
  expect(await count('city=hamburg')).toMatchObject({ APPLIED: 1, SCREENING: 0 });
  expect(await count(`q=${encodeURIComponent('Cy Board')}`)).toMatchObject({ APPLIED: 0, SCREENING: 1 });
  expect((await count('answer.relocate=true')).APPLIED).toBe(1);
  expect((await count('answer.work-permit=EU')).APPLIED).toBe(1);
  expect((await count('answer.relocate=false')).APPLIED).toBe(1);
  // A stage filter loads that column only; the counts still describe every column.
  const stageOnly = await (await board(ctxA, 'stage=SCREENING')).json();
  expect(Object.keys(stageOnly.columns)).toEqual(['SCREENING']);
  expect(stageOnly.counts.APPLIED).toBe(2);
  expect((await board(ctxA, 'stage=BOGUS')).status()).toBe(400);
  expect((await board(ctxA, 'answer.%24bad=1')).status()).toBe(400);

  const first = await (await board(ctxA, 'pageSize=1')).json();
  expect(first.columns.APPLIED.items).toHaveLength(1);
  expect(first.columns.APPLIED.hasMore).toBe(true);
  expect(first.counts.APPLIED).toBe(2);
  const second = await (await board(ctxA, 'column=APPLIED&page=2&pageSize=1')).json();
  expect(second.counts).toBeNull();
  expect(Object.keys(second.columns)).toEqual(['APPLIED']);
  expect(second.columns.APPLIED.items).toHaveLength(1);
  expect(second.columns.APPLIED.hasMore).toBe(false);
  expect(second.columns.APPLIED.items[0].id).not.toBe(first.columns.APPLIED.items[0].id);
});

test('the board moves a card from the keyboard-reachable select, bulk-rejects with a reason, and the drawer shows no contact data', async ({ page }) => {
  await signInAsFreshUser(page, emails.companyA, PW, '/company');
  await gotoSettled(page, `/company/requisitions/${reqA.id}`);
  await expect(page.getByTestId('requisition-openings')).toHaveText('3');
  await expect(page.getByTestId('applicant-count-APPLIED')).toHaveText('2');
  const applied = page.getByTestId('applicant-column-APPLIED');
  await expect(applied.getByTestId(`applicant-card-${apps.m1}`)).toBeVisible();
  // Zero axe violations, with a card selected so the bulk bar is scanned too.
  await page.getByTestId(`applicant-select-${apps.m3}`).check();
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  await page.getByTestId(`applicant-select-${apps.m3}`).uncheck();

  // Move Bo to Screening with the card's select.
  await page.getByTestId(`applicant-move-${apps.m2}`).selectOption('SCREENING');
  await page.getByTestId(`applicant-move-submit-${apps.m2}`).click();
  await expect(page.getByTestId('applicant-count-SCREENING')).toHaveText('2');
  await expect(page.getByTestId('applicant-column-SCREENING').getByTestId(`applicant-card-${apps.m2}`)).toBeVisible();
  expect((await prisma.application.findUniqueOrThrow({ where: { id: apps.m2 } })).stage).toBe('SCREENING');

  // Bulk: reject Ada and Bo together; a rejection needs a reason first.
  await page.getByTestId(`applicant-select-${apps.m1}`).check();
  await page.getByTestId(`applicant-select-${apps.m2}`).check();
  await page.getByTestId('bulk-stage').selectOption('REJECTED');
  await expect(page.getByTestId('bulk-move')).toBeDisabled();
  await page.getByTestId('bulk-reason').selectOption('SKILLS');
  await page.getByTestId('bulk-move').click();
  await expect(page.getByTestId('board-notice')).toContainText('2');
  await expect(page.getByTestId('applicant-count-REJECTED')).toHaveText('2');
  const rejected = await prisma.application.findMany({ where: { id: { in: [apps.m1, apps.m2] } }, select: { stage: true, dispositionCode: true } });
  expect(rejected.every((a) => a.stage === 'REJECTED' && a.dispositionCode === 'SKILLS')).toBe(true);

  // The drawer: profile fields, no e-mail, no phone; Escape closes it.
  await page.getByTestId(`applicant-open-${apps.m1}`).click();
  const drawer = page.getByTestId('candidate-drawer');
  await expect(drawer).toContainText('Berlin');
  await expect(drawer).toContainText('React');
  await expect(drawer).not.toContainText(emails.m1);
  await expect(drawer).not.toContainText('1234567');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
});
