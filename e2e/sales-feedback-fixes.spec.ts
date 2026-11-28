import crypto from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, asHost, MARKETING_HOST } from './helpers/auth';
// Static import: Playwright resolves the `@/…` alias in the spec's import graph only.
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * Small sales fixes from the in-app feedback, round 4 (#3976):
 *   1. the hand-off dialog keeps the current follow-up by default, offered first;
 *   2. the lead page's stage badge wears the board column's stage color;
 *   3. the follow-up's date and time boxes share one baseline;
 *   4. "Try again?" stacks in a narrow card without overflowing;
 *   5. the hand-off strip's load line is short, its whole split the hover text;
 *   6. "New lead" is on the board too.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'SalesFix3976!';
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const host = asHost(MARKETING_HOST);
const repEmail = uniqueEmail(`sf-rep-${STAMP}`);
const rep2Email = uniqueEmail(`sf-rep2-${STAMP}`);
let orgId = '';
let rep2Id = '';
let relId = '';

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales Fix ${STAMP}`, slug: `sf-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.pipelineStage.createMany({ data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId })) });
  const rep = await seedUser(repEmail, PW, 'MENTOR', `SF Rep ${STAMP}`, orgId);
  rep2Id = (await seedUser(rep2Email, PW, 'MENTOR', `SF Colleague ${STAMP}`, orgId)).id;
  const company = await prisma.company.create({ data: { orgId, name: `Example SF ${STAMP}`, contactName: 'Contact SF', contactPhone: '+49 30 2000001' } });
  const lead = await prisma.user.create({
    data: { orgId, email: `sf-lead-${STAMP}@import.local`, password: 'x', role: 'MENTEE', fullName: `Contact SF ${STAMP}`, phone: '+49 30 2000001', skills: [], companyId: company.id },
  });
  relId = (await prisma.mentorshipRelation.create({
    data: {
      orgId, mentorId: rep.id, menteeId: lead.id, companyId: company.id, pipelineStatus: 'LEAD_CONTACTED',
      nextActionAt: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`), nextActionType: 'call', nextActionNote: 'Ask about the budget',
    },
  })).id;
});

test.afterAll(async () => {
  await prisma.followUpEvent.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.interactionLog.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } }).catch(() => {});
  await prisma.activityLog.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { orgId, role: 'MENTEE' } }).catch(() => {});
  for (const e of [repEmail, rep2Email]) await cleanupByEmail(e);
  await prisma.company.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

async function signIn(page: Page) {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, repEmail, PW, '/sales');
}

async function box(page: Page, testId: string) {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b;
}

test('the board offers "New lead" and a load badge with the split on hover', async ({ page }) => {
  await signIn(page);
  await gotoSettled(page, '/sales/board');
  await expect(page.getByTestId('new-lead-button')).toBeVisible();
  const badge = page.getByTestId(`handoff-target-load-${rep2Id}`);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('aria-label', /open/);
  // One row (#3988): name and badge side by side, the chip no taller than the avatar line.
  const chip = await box(page, `handoff-target-${rep2Id}`);
  expect(chip.height).toBeLessThan(44);
  // A tap opens the detail, a tap elsewhere closes it. Bring the badge into view
  // first and let that scroll land: the popover closes on scroll by design, and the
  // scroll a click's own scrollIntoView causes is dispatched AFTER the click opened it.
  await badge.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await badge.click();
  await expect(page.getByTestId(`handoff-target-load-detail-${rep2Id}`)).toBeVisible();
  await page.mouse.move(0, 0);
  await page.mouse.click(5, 300);
  await expect(page.getByTestId(`handoff-target-load-detail-${rep2Id}`)).toHaveCount(0);
});

test('the hand-off dialog keeps the current follow-up by default, offered first', async ({ page }) => {
  await signIn(page);
  await gotoSettled(page, `/sales/leads/${relId}`);
  await page.getByTestId('sales-lead-handoff').click();
  const dialog = page.getByTestId('lead-handoff-dialog');
  await expect(dialog).toBeVisible();
  const keep = page.getByTestId('lead-handoff-follow-up-keep');
  await expect(keep).toBeChecked();
  await expect(page.getByTestId('lead-handoff-follow-up-new')).not.toBeChecked();
  // Offered first.
  const radios = dialog.locator('input[name="lead-handoff-follow-up"]');
  await expect(radios.first()).toHaveAttribute('data-testid', 'lead-handoff-follow-up-keep');
  // A new follow-up is still one click away, and brings its fields.
  await page.getByTestId('lead-handoff-follow-up-new').check();
  await expect(keep).not.toBeChecked();
});

test('the stage badge wears the board column color', async ({ page }) => {
  await signIn(page);
  await gotoSettled(page, `/sales/leads/${relId}`);
  const stage = await prisma.pipelineStage.findFirstOrThrow({ where: { orgId, key: 'LEAD_CONTACTED' }, select: { color: true } });
  expect(stage.color).toMatch(/^#/);
  const hex = stage.color!.toLowerCase();
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
  const bg = await page.getByTestId('sales-lead-stage').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg.replace(/\s+/g, ' ')).toContain(rgb);
});

test('date and time share a baseline, and "Try again?" fits a narrow screen', async ({ page }) => {
  await signIn(page);
  await gotoSettled(page, `/sales/leads/${relId}`);

  // The follow-up editor, narrow: both boxes end on the same line.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByTestId('follow-up-edit').click();
  const date = await box(page, 'follow-up-date');
  const time = await box(page, 'follow-up-time');
  expect(Math.abs(date.y + date.height - (time.y + time.height))).toBeLessThanOrEqual(1);

  // "Not reached" opens the retry box (the contact actions live on the wide layout);
  // then, narrow: two fields side by side, the actions below them, nothing overflowing.
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSettled(page, `/sales/leads/${relId}`);
  await page.evaluate(() =>
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a[href^="tel:"]')) e.preventDefault();
    }, true),
  );
  await page.getByTestId('sales-lead-phone-link').click();
  await page.getByTestId('contact-reached-no').click();
  await expect(page.getByTestId('contact-retry')).toBeVisible();
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const rDate = await box(page, 'contact-retry-date');
    const rTime = await box(page, 'contact-retry-time');
    const save = await box(page, 'contact-retry-save');
    const retry = await box(page, 'contact-retry');
    expect(Math.abs(rDate.y + rDate.height - (rTime.y + rTime.height)), `baseline at ${width}`).toBeLessThanOrEqual(1);
    expect(save.y, `actions below at ${width}`).toBeGreaterThanOrEqual(rDate.y + rDate.height);
    expect(rTime.x + rTime.width, `inside the box at ${width}`).toBeLessThanOrEqual(retry.x + retry.width + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
