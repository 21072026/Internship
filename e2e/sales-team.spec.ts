import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { outcomeStageKeysFrom, startStageKey } from '../src/lib/pipeline';
import { currentPeriod, periodRange } from '../src/lib/meteringRules';
import { weekRange } from '../src/lib/salesTargetRule';

// The sales team page /sales/team (#3779, MARKETING only):
//
//   1. a rep opens it: the active total, the per-stage counts, this week's and
//      this month's new / won / lost, the open pipeline value per currency and
//      the per-person rows all match the seeded records;
//   2. the per-stage counts are the boards' counts: every rep's own board
//      (/sales/board, each rep's own book) summed per stage;
//   3. week vs month: a win between the month's start and the week's start (or
//      the other way round, when the week began in the previous month) counts
//      in exactly one window;
//   4. another org's records never reach the numbers or the names (@smoke);
//   5. INTERNSHIP cannot open the page.

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'SalesTeam123!';
const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const E = {
  admin: uniqueEmail(`team-admin-${STAMP}`),
  rep1: uniqueEmail(`team-rep1-${STAMP}`),
  rep2: uniqueEmail(`team-rep2-${STAMP}`),
  foreign: uniqueEmail(`team-foreign-${STAMP}`),
  intern: uniqueEmail(`team-intern-${STAMP}`),
};
const NAMES = {
  admin: `Team Admin ${STAMP}`,
  rep1: `Alpha Seller ${STAMP}`,
  rep2: `Bravo Seller ${STAMP}`,
  foreign: `Foreign Seller ${STAMP}`,
};
const leadEmails: string[] = [];
const orgIds: string[] = [];
const ids: Record<string, string> = {};
const K = { FIRST: '', TRIAL: '', WON: '', LOST: '' };
/** Whether the edge win (see beforeAll) falls in the week window, the month window, or both. */
let edgeInWeek = false;
let edgeInMonth = false;

async function seedOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Team ${label} ${STAMP}`, slug: `team-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({ data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })) });
  return org.id;
}

async function record(
  orgId: string,
  ownerId: string,
  stage: string,
  opts: { moves?: { from: string; to: string; at: Date }[]; nextActionAt?: Date; value?: { minor: number; currency: string } } = {},
) {
  const email = uniqueEmail(`team-lead-${STAMP}`);
  leadEmails.push(email);
  const lead = await seedUser(email, PASSWORD, 'MENTEE', `Team Lead ${leadEmails.length} ${STAMP}`, orgId);
  const rel = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: lead.id, pipelineStatus: stage, nextActionAt: opts.nextActionAt ?? null },
  });
  for (const m of opts.moves ?? []) {
    await prisma.statusChange.create({ data: { relationId: rel.id, fromStatus: m.from, toStatus: m.to, createdAt: m.at } });
  }
  if (opts.value) {
    await prisma.relationValue.create({ data: { orgId, relationId: rel.id, valueMinor: opts.value.minor, currency: opts.value.currency } });
  }
  return rel.id;
}

test.beforeAll(async () => {
  const orgA = await seedOrg('a');
  const orgB = await seedOrg('b');
  ids.orgA = orgA;
  // The ranked leaderboard follows the existing switch (default off for reps).
  await prisma.setting.create({ data: { orgId: orgA, key: 'salesLeaderboardForReps', value: 'true' } });
  const stages = await prisma.pipelineStage.findMany({ where: { orgId: orgA } });
  const outcome = outcomeStageKeysFrom(stages);
  K.WON = outcome.finished[0];
  K.LOST = outcome.offPath[0];
  K.FIRST = startStageKey(stages);
  K.TRIAL = stages.filter((s) => !s.isOffPath && !outcome.finished.includes(s.key)).sort((a, b) => b.order - a.order)[0].key;
  expect(K.WON && K.LOST && K.FIRST && K.TRIAL && K.FIRST !== K.TRIAL).toBeTruthy();

  ids.admin = (await seedUser(E.admin, PASSWORD, 'ADMIN', NAMES.admin, orgA)).id;
  ids.rep1 = (await seedUser(E.rep1, PASSWORD, 'MENTOR', NAMES.rep1, orgA)).id;
  ids.rep2 = (await seedUser(E.rep2, PASSWORD, 'MENTOR', NAMES.rep2, orgA)).id;
  ids.foreign = (await seedUser(E.foreign, PASSWORD, 'MENTOR', NAMES.foreign, orgB)).id;
  ids.intern = (await seedUser(E.intern, PASSWORD, 'MENTOR', `Team Intern ${STAMP}`, null)).id;

  const now = new Date();
  const month = periodRange(currentPeriod(now));
  const week = weekRange(now);
  // Inside BOTH windows whatever minute the suite runs.
  const both = new Date(Math.max(month.gte.getTime(), week.gte.getTime(), now.getTime() - 60_000));
  // Inside exactly ONE window: between the two starts. The later start is
  // the one now's window shares with the other; the earlier one only belongs
  // to the longer reach. When both start at the same instant there is no such
  // time, and the edge win falls in both.
  const earlier = Math.min(month.gte.getTime(), week.gte.getTime());
  const later = Math.max(month.gte.getTime(), week.gte.getTime());
  const edge = later > earlier ? new Date(earlier + 60_000) : both;
  edgeInWeek = edge.getTime() >= week.gte.getTime();
  edgeInMonth = edge.getTime() >= month.gte.getTime();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

  // rep1: two first-stage leads, one in trial with an overdue follow-up and a
  // value, a win in both windows, and the edge win.
  await record(orgA, ids.rep1, K.FIRST);
  await record(orgA, ids.rep1, K.FIRST);
  await record(orgA, ids.rep1, K.TRIAL, { nextActionAt: threeDaysAgo, value: { minor: 150_000, currency: 'EUR' } });
  await record(orgA, ids.rep1, K.WON, { moves: [{ from: K.TRIAL, to: K.WON, at: both }], value: { minor: 99_999, currency: 'EUR' } });
  await record(orgA, ids.rep1, K.WON, { moves: [{ from: K.TRIAL, to: K.WON, at: edge }] });
  // rep2: one first-stage lead with a USD value, one lost in both windows.
  await record(orgA, ids.rep2, K.FIRST, { value: { minor: 5_000, currency: 'USD' } });
  await record(orgA, ids.rep2, K.LOST, { moves: [{ from: K.FIRST, to: K.LOST, at: both }] });

  // The other org: more of everything, so a leak would show.
  for (let i = 0; i < 3; i++) await record(orgB, ids.foreign, K.FIRST, { value: { minor: 777_700, currency: 'EUR' } });
  for (let i = 0; i < 4; i++) await record(orgB, ids.foreign, K.WON, { moves: [{ from: K.TRIAL, to: K.WON, at: both }] });
});

test.afterAll(async () => {
  for (const email of [...Object.values(E), ...leadEmails]) await cleanupByEmail(email);
  await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

async function signInMarketing(page: Page, email: string, landing: string) {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, email, PASSWORD, landing);
}

/** A rep's own board, per stage (a column without a count reads 0). */
async function boardCounts(page: Page): Promise<Record<string, number>> {
  await gotoSettled(page, '/sales/board');
  await expect(page.getByTestId(`board-column-count-${K.FIRST}`).first()).toBeVisible({ timeout: 20_000 });
  const out: Record<string, number> = {};
  for (const key of Object.values(K)) {
    const el = page.getByTestId(`board-column-count-${key}`).first();
    out[key] = (await el.count()) ? Number((await el.innerText()).trim().split(/\D+/).filter(Boolean)[0] ?? 0) : 0;
  }
  return out;
}

test('a rep sees the team totals, the stages, both windows, the value and the per-person rows', async ({ page }) => {
  test.slow();
  await signInMarketing(page, E.rep1, '/sales');
  // One card on the dashboard leads here …
  await expect(page.getByTestId('sales-team-card')).toHaveAttribute('href', '/sales/team');
  // … and so does the sales menu.
  await page.getByTestId('sales-nav').getByRole('link', { name: 'Team', exact: true }).click();
  await page.waitForURL('**/sales/team');
  await gotoSettled(page, '/sales/team');

  await expect(page.getByTestId('sales-team-active')).toHaveText('7');
  await expect(page.getByTestId(`sales-team-stage-count-${K.FIRST}`)).toHaveText('3');
  await expect(page.getByTestId(`sales-team-stage-count-${K.TRIAL}`)).toHaveText('1');
  await expect(page.getByTestId(`sales-team-stage-count-${K.WON}`)).toHaveText('2');
  await expect(page.getByTestId(`sales-team-stage-count-${K.LOST}`)).toHaveText('1');

  const wonWeek = 1 + (edgeInWeek ? 1 : 0);
  const wonMonth = 1 + (edgeInMonth ? 1 : 0);
  await expect(page.getByTestId('sales-team-week-new')).toHaveText('7');
  await expect(page.getByTestId('sales-team-week-won')).toHaveText(String(wonWeek));
  await expect(page.getByTestId('sales-team-week-lost')).toHaveText('1');
  await expect(page.getByTestId('sales-team-month-new')).toHaveText('7');
  await expect(page.getByTestId('sales-team-month-won')).toHaveText(String(wonMonth));
  await expect(page.getByTestId('sales-team-month-lost')).toHaveText('1');

  // Open records only (the won deal's 999.99 € is closed), never converted.
  await expect(page.getByTestId('sales-team-value-EUR')).toContainText('1,500.00');
  await expect(page.getByTestId('sales-team-value-USD')).toContainText('50.00');

  const r1 = page.getByTestId(`sales-team-rep-${ids.rep1}`);
  await expect(r1.getByTestId('rep-open')).toHaveText('5');
  await expect(r1.getByTestId('rep-won-week')).toHaveText(String(wonWeek));
  await expect(r1.getByTestId('rep-won-month')).toHaveText(String(wonMonth));
  await expect(r1.getByTestId('rep-overdue')).toHaveText('1');
  await expect(r1).toHaveAttribute('aria-current', 'true');
  const r2 = page.getByTestId(`sales-team-rep-${ids.rep2}`);
  await expect(r2.getByTestId('rep-open')).toHaveText('2');
  await expect(r2.getByTestId('rep-won-month')).toHaveText('0');
  await expect(r2.getByTestId('rep-overdue')).toHaveText('0');
  await expect(page.getByTestId(`sales-team-rep-${ids.admin}`).getByTestId('rep-open')).toHaveText('0');

  // The leaderboard (switched on for this org), ranked by wins.
  const month = page.getByTestId('sales-team-rank-month');
  await expect(month.locator('tbody tr').first()).toContainText(NAMES.rep1);
  await expect(month.locator('tbody tr').first().locator('td').last()).toHaveText(String(wonMonth));
  await expect(page.getByTestId('sales-team-rank-week').locator('tbody tr').first().locator('td').last()).toHaveText(String(wonWeek));

  // Names and counts only: no lead's name anywhere on the page.
  await expect(page.getByText(`Team Lead 1 ${STAMP}`)).toHaveCount(0);

  // No WCAG 2.2 AA violation on the page itself (bars are aria-hidden, every
  // number is text beside its label).
  const axe = await new AxeBuilder({ page }).include('[data-testid="sales-team"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});

test("the stage counts are the reps' boards added up", async ({ browser }) => {
  test.slow();
  const sum: Record<string, number> = {};
  for (const email of [E.rep1, E.rep2]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInMarketing(page, email, '/sales');
    const counts = await boardCounts(page);
    for (const [k, n] of Object.entries(counts)) sum[k] = (sum[k] ?? 0) + n;
    await ctx.close();
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInMarketing(page, E.rep2, '/sales');
  await gotoSettled(page, '/sales/team');
  for (const key of Object.values(K)) {
    await expect(page.getByTestId(`sales-team-stage-count-${key}`)).toHaveText(String(sum[key]));
  }
  await ctx.close();
});

test("another org's records never reach the numbers or the names", { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  await signInMarketing(page, E.rep2, '/sales');
  await gotoSettled(page, '/sales/team');
  await expect(page.getByTestId('sales-team-active')).toHaveText('7');
  await expect(page.getByTestId('sales-team')).not.toContainText(NAMES.foreign);
  await expect(page.getByTestId('sales-team-value-EUR')).not.toContainText('7,777');
  await expect(page.getByTestId(`sales-team-rep-${ids.foreign}`)).toHaveCount(0);

  // And the other way round: the foreign rep sees their own org only.
  await page.context().clearCookies();
  await signInMarketing(page, E.foreign, '/sales');
  await gotoSettled(page, '/sales/team');
  await expect(page.getByTestId('sales-team-active')).toHaveText('7');
  await expect(page.getByTestId(`sales-team-stage-count-${K.WON}`)).toHaveText('4');
  for (const name of [NAMES.rep1, NAMES.rep2, NAMES.admin]) await expect(page.getByTestId('sales-team')).not.toContainText(name);
});

test('with the team book off for reps, a rep gets a 404 and an admin still sees the page', async ({ page }) => {
  test.slow();
  await prisma.setting.create({ data: { orgId: ids.orgA, key: 'salesTeamBookForReps', value: 'false' } });
  try {
    await signInMarketing(page, E.rep1, '/sales');
    const res = await page.goto('/sales/team');
    expect(res?.status()).toBe(404);
    await expect(page.getByTestId('sales-team')).toHaveCount(0);

    await page.context().clearCookies();
    await signInMarketing(page, E.admin, '/admin');
    await gotoSettled(page, '/sales/team');
    await expect(page.getByTestId('sales-team-active')).toHaveText('7');
  } finally {
    await prisma.setting.deleteMany({ where: { orgId: ids.orgA, key: 'salesTeamBookForReps' } });
  }
});

test('INTERNSHIP cannot open the team page', async ({ page }) => {
  test.slow();
  await signInAndSettle(page, E.intern, PASSWORD, '/mentor');
  await page.goto('/sales/team');
  await expect(page).not.toHaveURL(/\/sales\/team/);
  await expect(page.getByTestId('sales-team')).toHaveCount(0);
});

test('dark mode and phone width: the page stays readable and fits', async ({ page }, testInfo) => {
  test.slow();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.context().addCookies([{ name: 'theme', value: 'dark', url: testInfo.project.use.baseURL ?? 'http://localhost:3000' }]);
  await signInMarketing(page, E.rep1, '/sales');
  await gotoSettled(page, '/sales/team');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.getByTestId('sales-team-active')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page }).include('[data-testid="sales-team"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
});
