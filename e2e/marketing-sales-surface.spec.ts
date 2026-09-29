import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';
import {
  MARKETING_MENTOR_ADMIN_ONLY,
  MARKETING_MENTOR_PAGES,
  MARKETING_MENTOR_ROWS,
  type SalesExpectation,
} from './fixtures/authz-matrix';
// Static imports, not `await import()`: Playwright resolves the `@/…` alias when
// it transforms the spec's import graph, Node at runtime does not.
import {
  TRIAL_ACTIVE_STAGE_KEY,
  TRIAL_EXPIRED_STAGE_KEY,
  defaultTemplateForVertical,
  templateStagePayload,
} from '../src/lib/programTemplates';

// The MARKETING sales surface (#2580, role decision (b)): a sales rep is a
// MENTOR, and in a vertical without mentorship that MENTOR works on /sales.
//
// Acceptance, from the issue:
//   1. the rep signs in, lands on the sales surface and sees the board and
//      their OWN attention queue (trial_expired, trial_no_end_date,
//      next_action_due);
//   2. they see only their own records — not a colleague's of the same org, not
//      another org's — on every screen and by id;
//   3. admin-only endpoints (settings, users, invites, deletes, imports,
//      organization) refuse them.
// The probe lists live in e2e/fixtures/authz-matrix.ts with the rest of the
// role × endpoint matrix; this spec only seeds and substitutes.

test.describe.configure({ mode: 'serial' });

const DAY = 24 * 60 * 60 * 1000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const PASSWORD = 'SalesRep123!';
const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const repEmail = uniqueEmail(`sales-rep-${STAMP}`);
const colleagueEmail = uniqueEmail(`sales-colleague-${STAMP}`);
const foreignRepEmail = uniqueEmail(`sales-foreign-${STAMP}`);
const leadEmails = [1, 2, 3].map((n) => uniqueEmail(`sales-lead${n}-${STAMP}`));
const colleagueLeadEmail = uniqueEmail(`sales-colleague-lead-${STAMP}`);
const foreignLeadEmail = uniqueEmail(`sales-foreign-lead-${STAMP}`);
const emails = [repEmail, colleagueEmail, foreignRepEmail, ...leadEmails, colleagueLeadEmail, foreignLeadEmail];

const NAMES = {
  expired: `Expired Trial Lead ${STAMP}`,
  undated: `Undated Trial Lead ${STAMP}`,
  followUp: `Follow Up Lead ${STAMP}`,
  colleague: `Colleague Lead ${STAMP}`,
  foreign: `Foreign Lead ${STAMP}`,
};

const orgIds: string[] = [];
const companyIds: string[] = [];
const ids: Record<string, string> = {};
const leadIds: Record<string, string> = {};

async function seedOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Sales ${label} ${STAMP}`, slug: `sales-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  return org.id;
}

async function user(email: string, role: 'MENTOR' | 'MENTEE', name: string, orgId: string) {
  const u = await seedUser(email, PASSWORD, role, name);
  await prisma.user.update({ where: { id: u.id }, data: { orgId } });
  return u.id;
}

async function company(orgId: string, name: string) {
  const c = await prisma.company.create({ data: { orgId, name } });
  companyIds.push(c.id);
  return c.id;
}

test.beforeAll(async () => {
  const orgA = await seedOrg('a');
  const orgB = await seedOrg('b');

  const rep = await user(repEmail, 'MENTOR', `Sales Rep ${STAMP}`, orgA);
  const colleague = await user(colleagueEmail, 'MENTOR', `Colleague Rep ${STAMP}`, orgA);
  const foreignRep = await user(foreignRepEmail, 'MENTOR', `Foreign Rep ${STAMP}`, orgB);
  const [l1, l2, l3] = await Promise.all([
    user(leadEmails[0], 'MENTEE', NAMES.expired, orgA),
    user(leadEmails[1], 'MENTEE', NAMES.undated, orgA),
    user(leadEmails[2], 'MENTEE', NAMES.followUp, orgA),
  ]);
  const lc = await user(colleagueLeadEmail, 'MENTEE', NAMES.colleague, orgA);
  const lf = await user(foreignLeadEmail, 'MENTEE', NAMES.foreign, orgB);
  ids.ownLeadId = l1;
  ids.repId = rep;
  leadIds.followUp = l3;

  ids.ownCompanyId = await company(orgA, `Own Account ${STAMP}`);
  ids.colleagueCompanyId = await company(orgA, `Colleague Account ${STAMP}`);
  ids.foreignCompanyId = await company(orgB, `Foreign Account ${STAMP}`);

  const now = Date.now();
  // trial_expired: parked in TRIAL_EXPIRED by the sweep.
  const expired = await prisma.mentorshipRelation.create({
    data: {
      orgId: orgA, mentorId: rep, menteeId: l1, companyId: ids.ownCompanyId,
      pipelineStatus: TRIAL_EXPIRED_STAGE_KEY,
      trialStartedAt: new Date(now - 32 * DAY), trialEndsAt: new Date(now - 2 * DAY),
      // …and past its stage SLA too: `overdue` is in the issue's minimum set.
      stageDeadline: new Date(now - DAY),
    },
  });
  ids.ownRelationId = expired.id;
  // trial_no_end_date: a running trial nobody dated.
  const undated = await prisma.mentorshipRelation.create({
    data: {
      orgId: orgA, mentorId: rep, menteeId: l2, companyId: ids.ownCompanyId,
      pipelineStatus: TRIAL_ACTIVE_STAGE_KEY, trialStartedAt: new Date(now - 5 * DAY),
    },
  });
  ids.undatedRelationId = undated.id;
  // next_action_due: the follow-up the rep promised themselves went by.
  const followUp = await prisma.mentorshipRelation.create({
    data: {
      orgId: orgA, mentorId: rep, menteeId: l3,
      pipelineStatus: 'LEAD_QUALIFIED', nextActionAt: new Date(now - 3 * DAY), nextActionNote: 'Call back',
    },
  });
  ids.followUpRelationId = followUp.id;
  // A colleague's record of the same org — with the same trouble, so it WOULD
  // be in a queue that leaked.
  const colleagueRel = await prisma.mentorshipRelation.create({
    data: {
      orgId: orgA, mentorId: colleague, menteeId: lc, companyId: ids.colleagueCompanyId,
      pipelineStatus: TRIAL_EXPIRED_STAGE_KEY, trialEndsAt: new Date(now - DAY),
    },
  });
  ids.colleagueRelationId = colleagueRel.id;
  const foreignRel = await prisma.mentorshipRelation.create({
    data: {
      orgId: orgB, mentorId: foreignRep, menteeId: lf, companyId: ids.foreignCompanyId,
      pipelineStatus: TRIAL_EXPIRED_STAGE_KEY, trialEndsAt: new Date(now - DAY),
    },
  });
  ids.foreignRelationId = foreignRel.id;
});

test.afterAll(async () => {
  for (const email of emails) await cleanupByEmail(email);
  await prisma.company.deleteMany({ where: { id: { in: companyIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

function fill(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    if (!ids[key]) throw new Error(`no seeded id for :${key}`);
    return ids[key];
  });
}

function statusMatches(status: number, expected: SalesExpectation): boolean {
  switch (expected) {
    case 'deny':
      return status === 401 || status === 403;
    case 'forbidden':
      return status === 403;
    case 'notFound':
      return status === 404;
    case 'ok':
      return status === 200;
  }
}

async function signInRep(page: Page) {
  await signInAndSettle(page, repEmail, PASSWORD, '/sales');
}

test('a MARKETING sales rep lands on the sales surface and sees only their own records', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  await signInRep(page);

  // The dashboard: their own attention queue, with the sales reasons.
  const queue = page.getByTestId('attention-queue');
  await expect(queue).toBeVisible();
  await expect(queue).toContainText(NAMES.expired);
  await expect(queue).toContainText('Trial expired — decide');
  await expect(queue).toContainText('Stage overdue');
  await expect(queue).toContainText(NAMES.undated);
  await expect(queue).toContainText('Trial end date missing — enter it');
  await expect(queue).toContainText(NAMES.followUp);
  await expect(queue).toContainText('Follow-up overdue');
  // Mentorship reasons never show on a sales record.
  await expect(queue).not.toContainText('No open goal or to-do');
  await expect(queue).not.toContainText('No recent contact');
  // Nobody else's record, whatever its state.
  await expect(queue).not.toContainText(NAMES.colleague);
  await expect(queue).not.toContainText(NAMES.foreign);

  const records = page.getByTestId('sales-records');
  for (const name of [NAMES.expired, NAMES.undated, NAMES.followUp]) await expect(records).toContainText(name);
  await expect(records).not.toContainText(NAMES.colleague);
  await expect(records).not.toContainText(NAMES.foreign);
  // MARKETING words through the vertical overlay.
  await expect(page.getByRole('heading', { name: 'Your sales pipeline' })).toBeVisible();
  await expect(page.getByTestId('sales-panel-label')).toHaveText('Sales');

  // The board: exactly their three cards.
  await page.getByTestId('sales-nav').getByRole('link', { name: 'Board', exact: true }).click();
  await page.waitForURL('**/sales/board');
  await expect(page.getByTestId('board-card')).toHaveCount(3, { timeout: 20_000 });
  await expect(page.getByText(NAMES.colleague)).toHaveCount(0);
  await expect(page.getByText(NAMES.foreign)).toHaveCount(0);
  // A card opens the sales lead page, not the mentor's mentee page.
  await expect(page.getByRole('link', { name: NAMES.expired })).toHaveAttribute('href', `/sales/leads/${ids.ownRelationId}`);

  // Their accounts: their own, not the colleague's or another org's.
  await gotoSettled(page, '/sales/accounts');
  const accounts = page.getByTestId('sales-accounts-table');
  await expect(accounts).toContainText(`Own Account ${STAMP}`);
  await expect(accounts).not.toContainText(`Colleague Account ${STAMP}`);
  await expect(accounts).not.toContainText(`Foreign Account ${STAMP}`);

  // The account page lists only their own records on it.
  await gotoSettled(page, `/sales/accounts/${ids.ownCompanyId}`);
  await expect(page.getByTestId('company-detail-name')).toHaveText(`Own Account ${STAMP}`);
  await expect(page.getByTestId('company-detail-relations')).toContainText(NAMES.expired);
  // No admin editor on the rep's view.
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

  // The API the board reads agrees: every row is theirs.
  const list = await page.request.get('/api/mentorship');
  expect(list.status()).toBe(200);
  const rows = ((await list.json()).relations ?? []) as Array<{ id: string }>;
  expect(rows.map((r) => r.id).sort()).toEqual(
    [ids.ownRelationId, ids.undatedRelationId, ids.followUpRelationId].sort(),
  );
});

test('the rep works their own record: the follow-up moves it out of the queue', async ({ page }) => {
  test.slow();
  await signInRep(page);
  await gotoSettled(page, `/sales/leads/${ids.followUpRelationId}`);
  await expect(page.getByTestId('sales-lead-name')).toHaveText(NAMES.followUp);

  const future = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
  await page.getByTestId('follow-up-date').fill(future);
  await page.getByTestId('follow-up-save').click();
  await expect
    .poll(async () => (await prisma.mentorshipRelation.findUnique({ where: { id: ids.followUpRelationId } }))?.nextActionAt?.toISOString().slice(0, 10))
    .toBe(future);

  await gotoSettled(page, '/sales');
  const queue = page.getByTestId('attention-queue');
  await expect(queue).toContainText(NAMES.expired);
  await expect(queue).not.toContainText(NAMES.followUp);

  // The trial-end editor is there on the undated trial, and its save clears
  // the "date missing" reason.
  // Driven through the rendered panel, not a raw PATCH — the panel is what the
  // lead page wires up.
  await gotoSettled(page, `/sales/leads/${ids.undatedRelationId}`);
  await expect(page.getByTestId('trial-end-missing').first()).toBeVisible();
  const trialEnd = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
  const panel = page.getByTestId('trial-end-panel');
  await panel.getByTestId('trial-end-input').fill(trialEnd);
  await panel.getByTestId('trial-end-save').click();
  await expect
    .poll(async () => (await prisma.mentorshipRelation.findUnique({ where: { id: ids.undatedRelationId } }))?.trialEndsAt?.toISOString().slice(0, 10))
    .toBe(trialEnd);
  await expect(panel.getByTestId('trial-end-missing-hint')).toHaveCount(0);
  await gotoSettled(page, '/sales');
  await expect(page.getByTestId('attention-queue')).not.toContainText(NAMES.undated);
});

test('the rep logs the call they just made from the lead page', async ({ page }) => {
  test.slow();
  await signInRep(page);
  await gotoSettled(page, `/sales/leads/${ids.followUpRelationId}`);
  const note = `Discussed pricing ${STAMP}`;
  const form = page.getByTestId('sales-lead-log-interaction');
  await form.getByRole('button', { name: /Log interaction|Add/i }).first().click();
  await form.getByRole('combobox').selectOption('Call');
  await form.locator('textarea').fill(note);
  await form.locator('button[type="submit"]').click();
  await expect(page.getByTestId('sales-lead-interactions')).toContainText(note);
  const logged = await prisma.interactionLog.findMany({ where: { relationId: ids.followUpRelationId } });
  expect(logged.map((l) => [l.type, l.notes])).toEqual([['Call', note]]);
  // A MARKETING lead is a record, not a portal user: no "your mentor logged
  // something" bell for them.
  expect(await prisma.notification.count({ where: { userId: leadIds.followUp, type: 'interaction.logged' } })).toBe(0);
});

test("a rep's stage-deadline reminder deep-links to their lead page", async ({ page }) => {
  test.slow();
  await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
  const res = await page.request.get('/api/cron?job=stage-deadlines');
  expect(res.ok()).toBeTruthy();
  const bell = await prisma.notification.findFirst({ where: { userId: ids.repId, type: 'deadline.stagePassed' } });
  expect(bell?.link).toBe(`/sales/leads/${ids.ownRelationId}`);
});

test('the rep cannot re-point their record at another account', async ({ page }) => {
  test.slow();
  await signInRep(page);
  // Same tenant, somebody else's account: re-pointing is an ADMIN decision in
  // a vertical without mentorship — else /sales/accounts would open it.
  const same = await page.request.put(`/api/mentorship/${ids.ownRelationId}`, { data: { companyId: ids.colleagueCompanyId } });
  expect(same.status()).toBe(403);
  const foreign = await page.request.put(`/api/mentorship/${ids.ownRelationId}`, { data: { companyId: ids.foreignCompanyId } });
  expect(foreign.status()).toBe(403);
  const row = await prisma.mentorshipRelation.findUnique({ where: { id: ids.ownRelationId } });
  expect(row?.companyId).toBe(ids.ownCompanyId);
  await gotoSettled(page, '/sales/accounts');
  await expect(page.getByTestId('sales-accounts-table')).not.toContainText(`Colleague Account ${STAMP}`);
});

test('admin-only endpoints refuse the rep', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  await signInRep(page);
  for (const probe of MARKETING_MENTOR_ADMIN_ONLY) {
    const res = await page.request.fetch(fill(probe.path), {
      method: probe.method,
      ...(probe.body ? { data: probe.body } : {}),
    });
    expect(statusMatches(res.status(), probe.expect), `${probe.method} ${probe.path} (${probe.why}) → ${res.status()}`).toBe(true);
  }
  // Nothing was written through them.
  expect(await prisma.company.count({ where: { id: ids.ownCompanyId } })).toBe(1);
  expect(await prisma.user.count({ where: { id: ids.ownLeadId } })).toBe(1);
});

test("another rep's and another org's records are out of reach, by id and by page", async ({ page }) => {
  test.slow();
  await signInRep(page);
  for (const probe of MARKETING_MENTOR_ROWS) {
    const res = await page.request.fetch(fill(probe.path), {
      method: probe.method,
      ...(probe.body ? { data: probe.body } : {}),
    });
    expect(statusMatches(res.status(), probe.expect), `${probe.method} ${probe.path} (${probe.why}) → ${res.status()}`).toBe(true);
  }
  for (const probe of MARKETING_MENTOR_PAGES) {
    const res = await page.request.get(fill(probe.path), { maxRedirects: 0 });
    expect(res.status(), `${probe.path} (${probe.why})`).toBe(probe.expect);
  }
  // The colleague's record was not touched by the refused PUT.
  const colleague = await prisma.mentorshipRelation.findUnique({ where: { id: ids.colleagueRelationId } });
  expect(colleague?.nextActionNote ?? null).toBeNull();
});
