import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { outcomeStageKeysFrom } from '../src/lib/pipeline';
import { currentPeriod, periodRange, previousPeriod } from '../src/lib/meteringRules';

// Monthly won-deal target + team leaderboard on /sales (MARKETING only).
//
//   1. a rep sees their own "won this month" count; the leaderboard is OFF by
//      default for reps;
//   2. an admin of the org sets the target and switches the board on from the
//      settings screen, and always sees the board on /sales;
//   3. the rep then sees "N of target" with a progressbar and the board — their
//      own org's reps only, never another org's (the negative tenant test: the
//      foreign rep has MORE wins than anyone, so a leak would top the list);
//   4. what counts is a first move into a won stage this month: last month's
//      win, a deal whose history starts won, and a re-win after a handover
//      (a transfer chain is one deal) do not;
//   5. INTERNSHIP never gets it: the settings API refuses the keys and the form
//      does not show them.

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'SalesTarget123!';
const STAMP = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const E = {
  adminA: uniqueEmail(`st-admin-a-${STAMP}`),
  rep1: uniqueEmail(`st-rep1-${STAMP}`),
  rep2: uniqueEmail(`st-rep2-${STAMP}`),
  rep3: uniqueEmail(`st-rep3-${STAMP}`),
  foreignRep: uniqueEmail(`st-foreign-${STAMP}`),
  internAdmin: uniqueEmail(`st-intern-admin-${STAMP}`),
};
const NAMES = {
  rep1: `Alpha Rep ${STAMP}`,
  rep2: `Bravo Rep ${STAMP}`,
  rep3: `Charlie Rep ${STAMP}`,
  foreignRep: `Foreign Rep ${STAMP}`,
  adminA: `ST Admin A ${STAMP}`,
};
const leadEmails: string[] = [];
const orgIds: string[] = [];
const ids: Record<string, string> = {};

async function seedOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `ST ${label} ${STAMP}`, slug: `st-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  orgIds.push(org.id);
  const preset = defaultTemplateForVertical('MARKETING')!;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  return org.id;
}

async function user(email: string, role: 'ADMIN' | 'MENTOR' | 'MENTEE', name: string, orgId: string | null) {
  const u = await seedUser(email, PASSWORD, role, name, orgId);
  return u.id;
}

/** One deal for `ownerId` with the given stage moves. */
async function deal(
  orgId: string,
  ownerId: string,
  moves: { from: string; to: string; at: Date }[],
  status: string,
  previousRelationId?: string,
) {
  const email = uniqueEmail(`st-lead-${STAMP}`);
  leadEmails.push(email);
  const lead = await user(email, 'MENTEE', `ST Lead ${leadEmails.length} ${STAMP}`, orgId);
  const rel = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: lead, pipelineStatus: status, previousRelationId },
  });
  for (const m of moves) {
    await prisma.statusChange.create({
      data: { relationId: rel.id, fromStatus: m.from, toStatus: m.to, createdAt: m.at },
    });
  }
  return rel.id;
}

let WON = '';
let LOST = '';
let TRIAL = '';

test.beforeAll(async () => {
  const orgA = await seedOrg('a');
  const orgB = await seedOrg('b');
  ids.orgA = orgA;
  ids.orgB = orgB;
  const stages = await prisma.pipelineStage.findMany({ where: { orgId: orgA } });
  const outcome = outcomeStageKeysFrom(stages.map((s) => ({ ...s, label: s.label })));
  WON = outcome.finished[0];
  LOST = outcome.offPath[0];
  TRIAL = stages.filter((s) => !s.isOffPath && !outcome.finished.includes(s.key)).sort((a, b) => b.order - a.order)[0].key;
  expect(WON && LOST && TRIAL).toBeTruthy();

  ids.adminA = await user(E.adminA, 'ADMIN', NAMES.adminA, orgA);
  ids.rep1 = await user(E.rep1, 'MENTOR', NAMES.rep1, orgA);
  ids.rep2 = await user(E.rep2, 'MENTOR', NAMES.rep2, orgA);
  ids.rep3 = await user(E.rep3, 'MENTOR', NAMES.rep3, orgA);
  ids.foreignRep = await user(E.foreignRep, 'MENTOR', NAMES.foreignRep, orgB);
  // An INTERNSHIP (default org) admin, for the gate.
  ids.internAdmin = await user(E.internAdmin, 'ADMIN', `ST Intern Admin ${STAMP}`, null);

  const now = new Date();
  // Inside this month whatever minute the suite runs (a minute ago, or the
  // period's first instant when the month is younger than that).
  const monthStart = periodRange(currentPeriod(now)).gte;
  const thisMonthSafe = new Date(Math.max(monthStart.getTime(), now.getTime() - 60_000));
  const lastMonth = new Date(periodRange(previousPeriod(currentPeriod(now))).gte.getTime() + 24 * 60 * 60 * 1000);

  // rep1: two wins this month …
  await deal(orgA, ids.rep1, [{ from: TRIAL, to: WON, at: thisMonthSafe }], WON);
  await deal(orgA, ids.rep1, [{ from: TRIAL, to: WON, at: thisMonthSafe }], WON);
  // … one last month (not counted) …
  await deal(orgA, ids.rep1, [{ from: TRIAL, to: WON, at: lastMonth }], WON);
  // … and one whose history starts won (a transfer successor): lost and back
  // this month, still not a win of this month.
  await deal(orgA, ids.rep1, [
    { from: WON, to: LOST, at: thisMonthSafe },
    { from: LOST, to: WON, at: thisMonthSafe },
  ], WON);
  // rep2: one win this month; rep3: none.
  await deal(orgA, ids.rep2, [{ from: TRIAL, to: WON, at: thisMonthSafe }], WON);
  // A transfer chain (#2289): rep2 won it last month and lost it, it was handed
  // to rep3 on the lost stage, and rep3 re-won it this month. One deal, one win
  // (rep2's, last month) — rep3 stays at 0 and rep2 at 1.
  const handedOver = await deal(orgA, ids.rep2, [
    { from: TRIAL, to: WON, at: lastMonth },
    { from: WON, to: LOST, at: new Date(lastMonth.getTime() + 60 * 60 * 1000) },
  ], LOST);
  await deal(orgA, ids.rep3, [{ from: LOST, to: WON, at: thisMonthSafe }], WON, handedOver);
  // The other org's rep: five wins this month.
  for (let i = 0; i < 5; i++) await deal(orgB, ids.foreignRep, [{ from: TRIAL, to: WON, at: thisMonthSafe }], WON);
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

test('a rep sees their own wins this month; the leaderboard is off for reps by default', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  await signInMarketing(page, E.rep1, '/sales');
  const card = page.getByTestId('sales-target-card');
  await expect(card).toBeVisible();
  // 2, not 3 (last month) and not 4 (the deal that started won).
  await expect(page.getByTestId('sales-target-headline')).toHaveText('Deals won this month: 2');
  await expect(page.getByTestId('sales-target-progress')).toHaveCount(0);
  await expect(page.getByTestId('sales-leaderboard')).toHaveCount(0);
  await expect(page.getByText(NAMES.rep2)).toHaveCount(0);
});

test('the admin sets a target, switches the board on, and always sees it', async ({ page }) => {
  test.slow();
  await signInMarketing(page, E.adminA, '/admin');
  await gotoSettled(page, '/admin/settings');
  const target = page.getByTestId('sales-won-target');
  await expect(target).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('sales-leaderboard-for-reps')).not.toBeChecked();

  // The admin sees the board on /sales even while it is off for reps.
  await gotoSettled(page, '/sales');
  const board = page.getByTestId('sales-leaderboard');
  await expect(board).toBeVisible();
  await expect(page.getByTestId('sales-leaderboard-visibility')).toHaveText(/Only admins see this list/);
  await expect(board).toContainText(NAMES.rep1);
  await expect(board).not.toContainText(NAMES.foreignRep);

  await gotoSettled(page, '/admin/settings');
  await expect(target).toBeEnabled({ timeout: 20_000 });
  await target.fill('4');
  await page.getByTestId('sales-leaderboard-for-reps').check();
  await page.locator('form').filter({ has: target }).locator('button[type="submit"]').click();
  await expect
    .poll(async () =>
      Object.fromEntries(
        (await prisma.setting.findMany({ where: { orgId: ids.orgA, key: { in: ['salesMonthlyWonTarget', 'salesLeaderboardForReps'] } } })).map((s) => [s.key, s.value]),
      ),
    )
    .toEqual({ salesMonthlyWonTarget: '4', salesLeaderboardForReps: 'true' });
  // Written to org A only — never the global row, never org B.
  expect(await prisma.setting.count({ where: { orgId: null, key: { in: ['salesMonthlyWonTarget', 'salesLeaderboardForReps'] } } })).toBe(0);
  expect(await prisma.setting.count({ where: { orgId: ids.orgB } })).toBe(0);
});

test('the rep sees "N of target" with a progressbar and their own org\'s board only', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  // The PR gate runs only `@smoke`, so the admin test above (which sets these
  // through the UI) is skipped there. Write the same two rows it writes, so
  // this test stands on its own whichever subset runs.
  for (const [key, value] of [['salesMonthlyWonTarget', '4'], ['salesLeaderboardForReps', 'true']] as const) {
    await prisma.setting.upsert({
      where: { orgId_key: { orgId: ids.orgA, key } },
      create: { orgId: ids.orgA, key, value },
      update: { value },
    });
  }
  await signInMarketing(page, E.rep1, '/sales');
  await expect(page.getByTestId('sales-target-headline')).toHaveText('2 of 4 deals won this month');
  const bar = page.getByRole('progressbar', { name: 'Monthly won-deal target' });
  await expect(bar).toHaveAttribute('aria-valuenow', '2');
  await expect(bar).toHaveAttribute('aria-valuemax', '4');

  const board = page.getByTestId('sales-leaderboard');
  await expect(board).toBeVisible();
  const rows = board.locator('tbody tr');
  // The org's admin is always on the board too, at 0 (maintainer decision
  // 2026-10-05); the tie at 0 is ordered by name, so after Charlie.
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText(NAMES.rep1);
  await expect(rows.nth(0)).toContainText('(you)');
  await expect(rows.nth(0).locator('td').last()).toHaveText('2');
  await expect(rows.nth(1)).toContainText(NAMES.rep2);
  await expect(rows.nth(1).locator('td').last()).toHaveText('1');
  await expect(rows.nth(2)).toContainText(NAMES.rep3);
  await expect(rows.nth(2).locator('td').last()).toHaveText('0');
  await expect(rows.nth(3)).toContainText(NAMES.adminA);
  await expect(rows.nth(3).locator('td').last()).toHaveText('0');
  // Negative tenant test: the other org's rep (5 wins) is nowhere.
  await expect(page.getByText(NAMES.foreignRep)).toHaveCount(0);
  // Names and counts only — no money anywhere on the card.
  await expect(board).not.toContainText('€');
});

test('dark mode and phone width: the card and board stay readable and fit', async ({ page }, testInfo) => {
  test.slow();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.context().addCookies([{ name: 'theme', value: 'dark', url: testInfo.project.use.baseURL ?? 'http://localhost:3000' }]);
  await signInMarketing(page, E.rep1, '/sales');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  await expect(page.getByTestId('sales-leaderboard')).toBeVisible();

  // WCAG contrast of the headline, the board's name cells and the hint against
  // the card surface they sit on.
  const ratios = await page.evaluate(() => {
    const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (el: Element, surface: Element) => {
      const a = lum(rgb(getComputedStyle(el).color));
      const b = lum(rgb(getComputedStyle(surface).backgroundColor));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const card = document.querySelector('[data-testid="sales-target-card"]')!;
    const board = document.querySelector('[data-testid="sales-leaderboard"]')!;
    return [
      ratio(document.querySelector('[data-testid="sales-target-headline"]')!, card),
      ratio(card.querySelector('p.text-xs')!, card),
      ratio(board.querySelector('tbody td:nth-child(2)')!, board),
      ratio(document.querySelector('[data-testid="sales-leaderboard-visibility"]')!, board),
    ];
  });
  for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);

  // No horizontal page scroll at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByTestId('sales-target-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('sales-target-dark-mobile.png'), fullPage: true });
});

test("the other org's rep sees their own board, without org A's names", async ({ page }) => {
  test.slow();
  await prisma.setting.create({ data: { orgId: ids.orgB, key: 'salesLeaderboardForReps', value: 'true' } });
  await signInMarketing(page, E.foreignRep, '/sales');
  // Org A's target does not reach org B.
  await expect(page.getByTestId('sales-target-headline')).toHaveText('Deals won this month: 5');
  const board = page.getByTestId('sales-leaderboard');
  await expect(board.locator('tbody tr')).toHaveCount(1);
  await expect(board).toContainText(NAMES.foreignRep);
  for (const name of [NAMES.rep1, NAMES.rep2, NAMES.rep3]) await expect(board).not.toContainText(name);
});

test('INTERNSHIP never gets it: the API refuses the keys and the form hides them', async ({ page }) => {
  test.slow();
  await signInAndSettle(page, E.internAdmin, PASSWORD, '/admin');
  for (const data of [{ salesLeaderboardForReps: 'true' }, { salesMonthlyWonTarget: '3' }]) {
    const res = await page.request.put('/api/admin/settings', { data });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe('vertical_mismatch');
  }
  // Nothing stored outside the two MARKETING test orgs — neither the default
  // org's row nor the global one.
  expect(
    await prisma.setting.count({
      where: {
        key: { in: ['salesMonthlyWonTarget', 'salesLeaderboardForReps'] },
        OR: [{ orgId: null }, { orgId: { notIn: orgIds } }],
      },
    }),
  ).toBe(0);
  await gotoSettled(page, '/admin/settings');
  await expect(page.getByTestId('ai-monthly-quota')).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('sales-won-target')).toHaveCount(0);
  await expect(page.getByTestId('sales-leaderboard-for-reps')).toHaveCount(0);
});

test('a rep cannot write the settings', async ({ page }) => {
  test.slow();
  await signInMarketing(page, E.rep2, '/sales');
  const res = await page.request.put('/api/admin/settings', { data: { salesMonthlyWonTarget: '1' } });
  expect([401, 403]).toContain(res.status());
});
