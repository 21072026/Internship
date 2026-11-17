import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInAndSettle, gotoSettled } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// #3838: the sales board's toolbar.
//   • In dark mode the selected "Mine / Team" button is readable — globals.css
//     repaints `.bg-gray-900` under html.dark, which used to beat
//     `dark:bg-gray-100` and leave dark text on a near-black button.
//   • Mine/Team, "show empty stages" and the search share one row, the search
//     at the far right, above the colleague strip; the admin board likewise
//     (saved views, owner filter, "hide empty stages", search).
//   • A collapsed empty stage keeps its colour without the 4px top stripe a
//     dashed frame breaks into blocks.

const PW = 'BoardToolbar123!';
const STAMP = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const H = asHost(MARKETING_HOST);
const emails: string[] = [];
let orgId = '';

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Toolbar ${STAMP}`, slug: `stoolbar-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  const preset = defaultTemplateForVertical('MARKETING');
  if (!preset) throw new Error('MARKETING must provision a stage preset');
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(preset, 'en').stages.map((st) => ({
      orgId, key: st.key, label: st.label, order: st.order, isTerminal: st.isTerminal, isOffPath: st.isOffPath, color: st.color,
    })),
  });
  const ids: string[] = [];
  for (const [label, role] of [['rep', 'MENTOR'], ['lead', 'MENTEE'], ['colleague', 'MENTOR'], ['admin', 'ADMIN']] as const) {
    const email = uniqueEmail(`stoolbar-${label}-${STAMP}`).toLowerCase();
    emails.push(email);
    ids.push((await seedUser(email, PW, role, `Toolbar ${label} ${STAMP}`, orgId)).id);
  }
  await prisma.mentorshipRelation.create({ data: { orgId, mentorId: ids[0], menteeId: ids[1], pipelineStatus: 'LEAD_QUALIFIED' } });
});

test.afterAll(async () => {
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('dark-mode toggle is readable, the toolbar is one row, an empty stage strip has no thick top', async ({ page, baseURL }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await page.context().addCookies([{ name: 'theme', value: 'dark', url: baseURL! }]);
  await signInAndSettle(page, emails[0], PW, '/sales');
  await gotoSettled(page, '/sales/board');
  await expect(page.locator('html')).toHaveClass(/\bdark\b/);

  // The selected button: light background, dark text — not dark on dark.
  const mine = page.getByTestId('sales-view-mine');
  await expect(mine).toHaveAttribute('aria-pressed', 'true');
  await expect(mine).toHaveCSS('background-color', 'rgb(243, 244, 246)');
  await expect(mine).toHaveCSS('color', 'rgb(17, 24, 39)');

  // One row: the search sits level with Mine/Team, to its right.
  const toggle = (await page.getByTestId('sales-view').boundingBox())!;
  const search = (await page.getByTestId('mentor-board-search').boundingBox())!;
  const showEmpty = (await page.getByTestId('board-show-empty').boundingBox())!;
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(middle(search) - middle(toggle))).toBeLessThan(12);
  expect(Math.abs(middle(showEmpty) - middle(toggle))).toBeLessThan(12);
  expect(showEmpty.x).toBeGreaterThan(toggle.x + toggle.width);
  expect(search.x).toBeGreaterThan(showEmpty.x);
  // Above the colleague strip, not below it.
  const strip0 = (await page.getByTestId('lead-handoff-strip').boundingBox())!;
  expect(search.y + search.height).toBeLessThanOrEqual(strip0.y);

  // "Contacted" is empty, so it is a dashed strip: its stage colour, 1px top.
  const strip = page.getByTestId('board-column-LEAD_CONTACTED');
  await expect(strip).toHaveAttribute('data-collapsed', 'true');
  await expect(strip).toHaveCSS('border-top-width', '1px');
  await expect(strip).toHaveCSS('border-top-color', 'rgb(14, 165, 233)');
  // An open column keeps its 4px stripe.
  await expect(page.getByTestId('board-column-LEAD_QUALIFIED')).toHaveCSS('border-top-width', '4px');
});

test('the admin board has one toolbar row above the colleague strip, search at the far right', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(H);
  await signInAndSettle(page, emails[3], PW, '/admin');
  await gotoSettled(page, '/admin/board');
  const toolbar = page.getByTestId('board-toolbar');
  const search = (await toolbar.getByTestId('board-search').boundingBox())!;
  const hide = (await toolbar.getByTestId('board-hide-empty').boundingBox())!;
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(middle(search) - middle(hide))).toBeLessThan(12);
  expect(search.x).toBeGreaterThan(hide.x);
  const tb = (await toolbar.boundingBox())!;
  const strip = (await page.getByTestId('lead-handoff-strip').boundingBox())!;
  expect(tb.y + tb.height).toBeLessThanOrEqual(strip.y);
});
